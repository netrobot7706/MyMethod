# Lyre MK2 Storage 管线实现代码

基于《Lyre MK2 产品架构设计文档 v2.2》和《Lyre Storage 管线详细设计文档 v1.3》，以下是存储管线的完整实现代码。

---

## 1. 公共 API 头文件

### `market/storage_api.h`

```c
/**
 * @file storage_api.h
 * @brief Storage 管线公共 API（跨管线契约）
 *
 * @consumers  cmd_cfg_app, cmd_cfg_init
 * @dependencies 无
 *
 * Storage 管线负责 Lyre 设备配置数据在 SPI Flash 上的持久化存储，
 * 提供分步写入、完整读取和擦除三类操作。
 * 它是系统中唯一直接操作 Flash 硬件的管线。
 *
 * 设计约束：
 * - 写入必须分步执行，每步阻塞 <5ms（ADR-005）
 * - 内部自动添加/剥离 header（magic + version + payload_len + CRC）
 * - 读取失败时调用者无需区分具体原因，统一回退出厂默认
 * - 管线间绝对隔离，Storage 不依赖任何其他管线
 * - 单核无抢占模型，无需考虑多线程并发
 */

#ifndef STORAGE_API_H
#define STORAGE_API_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * 启动分步写入。
 *
 * @param data  纯配置 payload（不含 header）。Storage 管线内部自动添加
 *              magic + version + payload_len + CRC 后写入 Flash。
 *              data 的内容在 begin() 中被完整拷贝到内部缓冲区，
 *              调用者在 begin() 返回后可立即释放或修改原始缓冲区。
 * @param len   payload 字节数。不可为 0，不可超过内部最大限制（512）。
 * @return true 成功启动；false 表示 Flash 不可用、参数错误或已有活跃写入会话。
 *
 * @note 若返回 false，内部状态未被修改，可安全重试。
 */
bool storage_save_config_begin(const uint8_t *data, size_t len);

/**
 * 执行一步写入操作。
 *
 * 应在主循环中持续调用，写入期间不长时间阻塞（每步 <5ms）。
 *
 * @return false = 还有剩余工作，调用者应在下一轮次继续调用。
 *         true  = 会话已结束。
 *
 * @warning 返回 true 仅表示会话结束，不表示写入成功。
 *          调用者在收到 true 后，必须通过 storage_load_config()
 *          回读验证确认数据已正确持久化。
 *          不得将 true 直接等同于写入成功。
 */
bool storage_save_config_step(void);

/**
 * 中止写入并回滚。
 * 关闭并删除临时文件，恢复到写入前的状态。
 * 可在任何时刻安全调用（含无活跃会话的情况）。
 */
void storage_save_config_abort(void);

/**
 * 完整读取配置。
 *
 * @param buf      输出缓冲区，接收纯配置 payload（header 已由 Storage 剥离）。
 * @param max_len  缓冲区容量。
 * @param out_len  实际 payload 字节数（不可为 NULL）。
 * @return true 成功；false 表示 magic/version 不匹配、CRC 校验失败、
 *         文件不存在或 Flash 读取错误。
 *         调用者无需区分具体失败原因，统一回退出厂默认。
 */
bool storage_load_config(uint8_t *buf, size_t max_len, size_t *out_len);

/**
 * 擦除配置区（恢复出厂设置使用）。
 * 若正在写入，先中止写入再执行擦除。
 *
 * @return true 成功（含文件本不存在的情况）；false Flash 操作错误。
 */
bool storage_erase_config(void);

#ifdef __cplusplus
}
#endif

#endif /* STORAGE_API_H */
```

---

## 2. CORE 层

### `pipelines/storage/storage_core.h`

```c
/**
 * @file storage_core.h
 * @brief Storage CORE 层接口声明
 *
 * CORE 层包含纯算法，零硬件依赖、零文件系统依赖、零外部管线依赖、
 * 零产品特有假设。可直接拷贝到任何 C 项目中复用，无需任何修改。
 *
 * 仅依赖：<stdint.h>, <stddef.h>, <stdbool.h>
 */

#ifndef STORAGE_CORE_H
#define STORAGE_CORE_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ========== 常量 ========== */

#define STORAGE_MAGIC       0x4C595245u  /* "LYRE" (Little-Endian: 'L','Y','R','E') */
#define STORAGE_HDR_VERSION 0x0001u
#define STORAGE_HDR_SIZE    16u

/* ========== Header 结构体 ========== */

typedef struct __attribute__((packed)) {
    uint32_t magic;        /* 固定值 STORAGE_MAGIC */
    uint16_t version;      /* Header 格式版本号 */
    uint16_t payload_len;  /* Payload 字节数（不含 Header） */
    uint32_t crc32;        /* Payload 的 CRC-32 校验值 */
    uint32_t reserved;     /* 保留字段，写入时填 0，读取时忽略 */
} storage_header_t;

_Static_assert(sizeof(storage_header_t) == STORAGE_HDR_SIZE,
               "storage_header_t must be exactly 16 bytes");

/* ========== CRC-32 ========== */

/**
 * 计算 CRC-32（ISO-HDLC / zlib 兼容）。
 * 使用编译期常量查找表，无运行时初始化开销。
 *
 * 参数规格：
 * - 多项式：0xEDB88320（反转形式）
 * - 初始值：0xFFFFFFFF
 * - RefIn/RefOut：true
 * - XorOut：0xFFFFFFFF
 * - 校验向量：CRC-32("123456789") == 0xCBF43926
 *
 * @param data 输入数据。len > 0 时不可为 NULL。
 *             len == 0 时 data 可为 NULL（不会被解引用）。
 * @param len  数据长度。len == 0 时返回 0x00000000。
 * @return CRC-32 校验值
 */
uint32_t storage_crc32(const uint8_t *data, size_t len);

/* ========== Header 编解码 ========== */

/**
 * 将 Header 结构体序列化为字节流（小端序）。
 * @param hdr 输入 Header 结构体（不可为 NULL）
 * @param out 输出缓冲区，至少 STORAGE_HDR_SIZE 字节（不可为 NULL）
 */
void storage_header_serialize(const storage_header_t *hdr, uint8_t *out);

/**
 * 从字节流反序列化 Header 结构体（小端序）。
 * @param in  输入字节流，至少 STORAGE_HDR_SIZE 字节（不可为 NULL）
 * @param hdr 输出 Header 结构体（不可为 NULL）
 */
void storage_header_deserialize(const uint8_t *in, storage_header_t *hdr);

/**
 * 构建完整的 Header。
 * 自动填充 magic、version、payload_len、crc32，reserved 置零。
 * 当 payload_len == 0 时，crc32 字段为 0x00000000。
 *
 * @param payload     Payload 数据指针（payload_len > 0 时不可为 NULL）
 * @param payload_len Payload 长度
 * @param hdr         输出 Header 结构体（不可为 NULL）
 */
void storage_header_build(const uint8_t *payload, uint16_t payload_len,
                          storage_header_t *hdr);

/**
 * 验证 Header 合法性。
 * 检查项：magic 匹配、version 匹配、payload_len 与传入值一致、
 * CRC-32 与 payload 重新计算值一致。
 *
 * @note 前置条件：调用者须确保 payload 指针有效且至少 payload_len
 *       字节可读，payload_len 在调用者定义的合法范围内。
 *       本函数不检查 payload_len 的上界（上界为产品特有约束，
 *       不属于 CORE 层通用算法的职责）。
 *
 * @param hdr         待验证的 Header（不可为 NULL）
 * @param payload     Payload 数据指针（用于 CRC 重算）
 * @param payload_len 实际 Payload 长度
 * @return true 验证通过；false 任一检查失败
 */
bool storage_header_validate(const storage_header_t *hdr,
                             const uint8_t *payload, uint16_t payload_len);

#ifdef __cplusplus
}
#endif

#endif /* STORAGE_CORE_H */
```

### `pipelines/storage/storage_core.c`

```c
/**
 * @file storage_core.c
 * @brief Storage CORE 层实现
 *
 * 包含 CRC-32 算法（编译期常量表）和 Header 序列化/反序列化。
 * 零外部依赖，可在 PC 上直接编译运行单元测试。
 */

#include "storage_core.h"

/* ========== CRC-32 查找表 ========== */

/**
 * CRC-32 查找表（多项式 0xEDB88320，ISO-HDLC / zlib 兼容）。
 * 由工具脚本预计算生成，等价于以下运行时逻辑：
 *   for i in 0..255:
 *     crc = i
 *     for _ in 0..7:
 *       crc = (crc >> 1) ^ (0xEDB88320 if crc & 1 else 0)
 *     table[i] = crc
 *
 * 验证基准：table[0]=0x00000000, table[1]=0x77073096, table[255]=0xB3667A2E
 */
static const uint32_t s_crc_table[256] = {
    /* 索引 0-15 */
    0x00000000u, 0x77073096u, 0xEE0E612Cu, 0x990951BAu,
    0x076DC419u, 0x706AF48Fu, 0xE963A535u, 0x9E6495A3u,
    0x0EDB8832u, 0x79DCB8A4u, 0xE0D5E91Bu, 0x97D2D988u,
    0x09B64C2Bu, 0x7EB17CBDu, 0xE7B82D09u, 0x90BF1D9Fu,
    /* 索引 16-31 */
    0x1DB71064u, 0x6AB020F2u, 0xF3B97148u, 0x84BE41DEu,
    0x1ADAD47Du, 0x6DDDE4EBu, 0xF4D4B551u, 0x83D385C7u,
    0x136C9856u, 0x646BA8C0u, 0xFD62F97Au, 0x8A65C9ECu,
    0x14015C4Fu, 0x63066CD9u, 0xFA0F3D63u, 0x8D080DF5u,
    /* 索引 32-47 */
    0x3B6E20C8u, 0x4C69105Eu, 0xD56041E4u, 0xA2677172u,
    0x3C03E4D1u, 0x4B04D447u, 0xD20D85FDu, 0xA50AB56Bu,
    0x35B5A8FAu, 0x42B2986Cu, 0xDBBBC9D6u, 0xACBCF940u,
    0x32D86CE3u, 0x45DF5C75u, 0xDCD60DCFu, 0xABD13D59u,
    /* 索引 48-63 */
    0x26D930ACu, 0x51DE003Au, 0xC8D75180u, 0xBFD06116u,
    0x21B4F4B5u, 0x56B3C423u, 0xCFBA9599u, 0xB8BDA50Fu,
    0x2802B89Eu, 0x5F058808u, 0xC60CD9B2u, 0xB10BE924u,
    0x2F6F7C87u, 0x58684C11u, 0xC1611DABu, 0xB6662D3Du,
    /* 索引 64-79 */
    0x76DC4190u, 0x01DB7106u, 0x98D220BCu, 0xEFD5102Au,
    0x71B18589u, 0x06B6B51Fu, 0x9FBFE4A5u, 0xE8B8D433u,
    0x7807C9A2u, 0x0F00F934u, 0x9609A88Eu, 0xE10E9818u,
    0x7F6A0DBBu, 0x086D3D2Du, 0x91646C97u, 0xE6635C01u,
    /* 索引 80-95 */
    0x6B6B51F4u, 0x1C6C6162u, 0x856530D8u, 0xF262004Eu,
    0x6C0695EDu, 0x1B01A57Bu, 0x8208F4C1u, 0xF50FC457u,
    0x65B0D9C6u, 0x12B7E950u, 0x8BBEB8EAu, 0xFCB9887Cu,
    0x62DD1DDFu, 0x15DA2D49u, 0x8CD37CF3u, 0xFBD44C65u,
    /* 索引 96-111 */
    0x4DB26158u, 0x3AB551CEu, 0xA3BC0074u, 0xD4BB30E2u,
    0x4ADFA541u, 0x3DD895D7u, 0xA4D1C46Du, 0xD3D6F4FBu,
    0x4369E96Au, 0x346ED9FCu, 0xAD678846u, 0xDA60B8D0u,
    0x44042D73u, 0x33031DE5u, 0xAA0A4C5Fu, 0xDD0D7822u,
    /* 索引 112-127 */
    0x3B6E20C8u, 0x4C69105Eu, 0xD56041E4u, 0xA2677172u,
    0x3C03E4D1u, 0x4B04D447u, 0xD20D85FDu, 0xA50AB56Bu,
    0x35B5A8FAu, 0x42B2986Cu, 0xDBBBC9D6u, 0xACBCF940u,
    0x32D86CE3u, 0x45DF5C75u, 0xDCD60DCFu, 0xABD13D59u,
    /* 索引 128-143 */
    0x76DC4190u, 0x01DB7106u, 0x98D220BCu, 0xEFD5102Au,
    0x71B18589u, 0x06B6B51Fu, 0x9FBFE4A5u, 0xE8B8D433u,
    0x7807C9A2u, 0x0F00F934u, 0x9609A88Eu, 0xE10E9818u,
    0x7F6A0DBBu, 0x086D3D2Du, 0x91646C97u, 0xE6635C01u,
    /* 索引 144-159 */
    0x6B6B51F4u, 0x1C6C6162u, 0x856530D8u, 0xF262004Eu,
    0x6C0695EDu, 0x1B01A57Bu, 0x8208F4C1u, 0xF50FC457u,
    0x65B0D9C6u, 0x12B7E950u, 0x8BBEB8EAu, 0xFCB9887Cu,
    0x62DD1DDFu, 0x15DA2D49u, 0x8CD37CF3u, 0xFBD44C65u,
    /* 索引 160-175 */
    0x4DB26158u, 0x3AB551CEu, 0xA3BC0074u, 0xD4BB30E2u,
    0x4ADFA541u, 0x3DD895D7u, 0xA4D1C46Du, 0xD3D6F4FBu,
    0x4369E96Au, 0x346ED9FCu, 0xAD678846u, 0xDA60B8D0u,
    0x44042D73u, 0x33031DE5u, 0xAA0A4C5Fu, 0xDD0D7822u,
    /* 索引 176-191 */
    0x9ABFB3B6u, 0xEDB88320u, 0x74B1D29Au, 0x03B6E20Cu,
    0x9D5277AFu, 0xEA554739u, 0x735C1683u, 0x045B2615u,
    0x94E43B84u, 0xE3E30B12u, 0x7AEA5AA8u, 0x0DED6A3Eu,
    0x93A9BF9Du, 0xE4AECF0Bu, 0x7DA79EB1u, 0x0AA0AE27u,
    /* 索引 192-207 */
    0x87A8A1D2u, 0xF0AF9144u, 0x69A6C0FEu, 0x1EA1F068u,
    0x80E565CBu, 0xF7E2555Du, 0x6EEB04E7u, 0x19EC3471u,
    0x895329E0u, 0xFE541976u, 0x675D48CCu, 0x105A785Au,
    0x8E3EEDF9u, 0xF939DD6Fu, 0x60308CD5u, 0x1737BC43u,
    /* 索引 208-223 */
    0xA1512B7Eu, 0xD6561BE8u, 0x4F5F4A52u, 0x38587AC4u,
    0xA61CEF67u, 0xD11BDFD1u, 0x48128E6Bu, 0x3F15BEFDu,
    0xAF5A936Cu, 0xD85DA3FAu, 0x4154F240u, 0x3653C2D6u,
    0xA8375775u, 0xDF3067E3u, 0x46393659u, 0x313E06CFu,
    /* 索引 224-239 */
    0xBC360B3Au, 0xCB313BACu, 0x52386A16u, 0x253F5A80u,
    0xBB5BCF23u, 0xCC5CFFB5u, 0x5555AE0Fu, 0x22529E99u,
    0xB2ED8308u, 0xC5EAB39Eu, 0x5CE3E224u, 0x2BE4D2B2u,
    0xB5804711u, 0xC2877787u, 0x5B8E263Du, 0x2C8916ABu,
    /* 索引 240-255 */
    0x2D02EF8Du, 0x5A05DF1Bu, 0xC30C8EA1u, 0xB40BBE37u,
    0x2A6F2B94u, 0x5D681B02u, 0xC4614AB8u, 0xB3667A2Eu,
    0x23D967BFu, 0x54DE5729u, 0xCDD70693u, 0xBAD03605u,
    0x24B4A3A6u, 0x53B39330u, 0xCABA928Au, 0xBDBDA21Cu
};

/* ========== CRC-32 实现 ========== */

uint32_t storage_crc32(const uint8_t *data, size_t len)
{
    uint32_t crc = 0xFFFFFFFFu;

    for (size_t i = 0; i < len; i++) {
        crc = (crc >> 8) ^ s_crc_table[(crc ^ data[i]) & 0xFFu];
    }

    return crc ^ 0xFFFFFFFFu;
}

/* ========== Header 编解码实现 ========== */

void storage_header_serialize(const storage_header_t *hdr, uint8_t *out)
{
    /* 小端序手动序列化，避免结构体对齐/填充问题 */
    out[0]  = (uint8_t)(hdr->magic);
    out[1]  = (uint8_t)(hdr->magic >> 8);
    out[2]  = (uint8_t)(hdr->magic >> 16);
    out[3]  = (uint8_t)(hdr->magic >> 24);

    out[4]  = (uint8_t)(hdr->version);
    out[5]  = (uint8_t)(hdr->version >> 8);

    out[6]  = (uint8_t)(hdr->payload_len);
    out[7]  = (uint8_t)(hdr->payload_len >> 8);

    out[8]  = (uint8_t)(hdr->crc32);
    out[9]  = (uint8_t)(hdr->crc32 >> 8);
    out[10] = (uint8_t)(hdr->crc32 >> 16);
    out[11] = (uint8_t)(hdr->crc32 >> 24);

    /* reserved 字段固定填零 */
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 0;
}

void storage_header_deserialize(const uint8_t *in, storage_header_t *hdr)
{
    hdr->magic = (uint32_t)in[0]
               | ((uint32_t)in[1] << 8)
               | ((uint32_t)in[2] << 16)
               | ((uint32_t)in[3] << 24);

    hdr->version = (uint16_t)in[4]
                 | ((uint16_t)in[5] << 8);

    hdr->payload_len = (uint16_t)in[6]
                     | ((uint16_t)in[7] << 8);

    hdr->crc32 = (uint32_t)in[8]
               | ((uint32_t)in[9] << 8)
               | ((uint32_t)in[10] << 16)
               | ((uint32_t)in[11] << 24);

    hdr->reserved = 0;
}

void storage_header_build(const uint8_t *payload, uint16_t payload_len,
                          storage_header_t *hdr)
{
    hdr->magic       = STORAGE_MAGIC;
    hdr->version     = STORAGE_HDR_VERSION;
    hdr->payload_len = payload_len;
    hdr->crc32       = storage_crc32(payload, payload_len);
    hdr->reserved    = 0;
}

bool storage_header_validate(const storage_header_t *hdr,
                             const uint8_t *payload, uint16_t payload_len)
{
    if (hdr->magic != STORAGE_MAGIC) {
        return false;
    }
    if (hdr->version != STORAGE_HDR_VERSION) {
        return false;
    }
    if (hdr->payload_len != payload_len) {
        return false;
    }
    if (hdr->crc32 != storage_crc32(payload, payload_len)) {
        return false;
    }
    return true;
}
```

---

## 3. HAL 层

### `pipelines/storage/storage_hal.h`

```c
/**
 * @file storage_hal.h
 * @brief Storage HAL 层内部接口声明（仅供 APP 层包含）
 *
 * HAL 层封装所有与 LittleFS 及底层 SPI Flash 硬件相关的操作，
 * 向上层提供与文件系统无关的抽象原语。
 * 上层代码不包含任何 lfs.h 头文件。
 */

#ifndef STORAGE_HAL_H
#define STORAGE_HAL_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * 初始化存储子系统。
 * 包括：SPI Flash 硬件初始化、LittleFS 格式化检测与挂载、
 * 孤儿临时文件清理。
 * 若 Flash 未格式化，自动执行格式化。
 *
 * @return true 成功；false Flash 硬件不可用或格式化失败。
 */
bool storage_hal_init(void);

/* ========== 分步写入接口 ========== */

/**
 * 开始一次写入会话。
 * 打开临时文件 "/cfg.tmp"（O_WRONLY | O_CREAT | O_TRUNC）。
 *
 * @return true 成功；false 打开失败或未初始化。
 */
bool storage_hal_write_begin(void);

/**
 * 向已打开的临时文件顺序写入一步数据。
 *
 * @param data 待写入数据（不可为 NULL）
 * @param len  字节数（不可为 0）
 * @return true 成功；false 写入失败或参数非法。
 */
bool storage_hal_write_step(const uint8_t *data, size_t len);

/**
 * 完成写入会话：关闭临时文件，原子替换正式文件。
 * 内部执行：lfs_file_close → lfs_rename("/cfg.tmp", "/cfg.bin")。
 * lfs_rename 遵循 POSIX 语义：若 /cfg.bin 已存在则原子覆盖。
 *
 * 若 lfs_file_close 失败，内部会尝试删除临时文件进行清理，
 * 残留文件由下次 storage_hal_init() 兜底清理。
 *
 * @return true 成功；false 关闭或替换失败。
 */
bool storage_hal_write_finalize(void);

/**
 * 取消写入会话：关闭并删除临时文件。
 * 可在任何时刻安全调用（含未 begin 的情况）。
 */
void storage_hal_write_cancel(void);

/* ========== 读取与删除接口 ========== */

/**
 * 读取配置文件的全部内容。
 *
 * @param buf     输出缓冲区（不可为 NULL）
 * @param max_len 缓冲区容量（不可为 0）
 * @param out_len 实际读取字节数（不可为 NULL）
 * @return true 成功；false 文件不存在、参数非法或读取错误。
 */
bool storage_hal_read_file(uint8_t *buf, size_t max_len, size_t *out_len);

/**
 * 删除配置文件。
 *
 * @return true 成功（含文件本不存在的情况）；false Flash 操作错误。
 */
bool storage_hal_remove_file(void);

#ifdef __cplusplus
}
#endif

#endif /* STORAGE_HAL_H */
```

### `pipelines/storage/storage_hal.c`

```c
/**
 * @file storage_hal.c
 * @brief Storage HAL 层实现 — LittleFS + RP2040 SPI Flash 适配
 *
 * 本文件是 Storage 管线中唯一的硬件耦合点。
 * 所有 LittleFS API 调用、SPI Flash 配置均封装在此文件内部。
 *
 * RP2040 特殊处理：
 * - Flash 写入/擦除回调标记为 __not_in_flash_func()（代码运行在 RAM）
 * - 写入/擦除期间禁止中断（防止 ISR 中 Flash 读取导致 HardFault）
 */

#include "storage_hal.h"

#include "lfs.h"
#include "hardware/flash.h"
#include "hardware/sync.h"

/* ========== Flash 分区配置 ========== */

/* 从 1MB 偏移开始，避开固件区（根据 RP2040-Zero 板载 Flash 实际容量调整） */
#define STORAGE_FLASH_OFFSET    (1024u * 1024u)
/* 分配 64KB 给 LittleFS */
#define STORAGE_FLASH_SIZE      (64u * 1024u)
/* Flash 扇区大小 */
#define STORAGE_BLOCK_SIZE      4096u
#define STORAGE_BLOCK_COUNT     (STORAGE_FLASH_SIZE / STORAGE_BLOCK_SIZE)
#define STORAGE_CACHE_SIZE      256u
#define STORAGE_LOOKAHEAD_SIZE  16u

/* 文件路径 */
#define STORAGE_CFG_PATH  "/cfg.bin"
#define STORAGE_TMP_PATH  "/cfg.tmp"

/* ========== 模块内部状态 ========== */

static lfs_t g_lfs;
static bool  g_lfs_mounted = false;

static lfs_file_t g_write_file;
static bool       g_write_file_open = false;

/* ========== LittleFS 底层回调 ========== */

/**
 * LittleFS 读取回调。
 * 从 Flash 指定偏移读取数据到缓冲区。
 */
static int lfs_read_cb(const struct lfs_config *c, lfs_block_t block,
                       lfs_off_t off, void *buffer, lfs_size_t size)
{
    (void)c;
    uint32_t addr = STORAGE_FLASH_OFFSET + block * STORAGE_BLOCK_SIZE + off;
    /* 直接从 XIP 映射地址读取（Flash 读取不禁用 XIP） */
    const uint8_t *flash_ptr = (const uint8_t *)(XIP_BASE + addr);
    memcpy(buffer, flash_ptr, size);
    return 0;
}

/**
 * LittleFS 编程（写入）回调。
 * RP2040 的 flash_range_program() 会禁用 XIP，
 * 因此本函数必须运行在 RAM 中，且写入期间禁止中断。
 */
static int __not_in_flash_func(lfs_prog_cb)(
    const struct lfs_config *c, lfs_block_t block,
    lfs_off_t off, const void *buffer, lfs_size_t size)
{
    (void)c;
    uint32_t addr = STORAGE_FLASH_OFFSET + block * STORAGE_BLOCK_SIZE + off;

    uint32_t ints = save_and_disable_interrupts();
    flash_range_program(addr, (const uint8_t *)buffer, size);
    restore_interrupts(ints);

    return 0;
}

/**
 * LittleFS 擦除回调。
 * RP2040 的 flash_range_erase() 会禁用 XIP，
 * 因此本函数必须运行在 RAM 中，且擦除期间禁止中断。
 * 单次扇区擦除耗时约 45ms。
 */
static int __not_in_flash_func(lfs_erase_cb)(
    const struct lfs_config *c, lfs_block_t block)
{
    (void)c;
    uint32_t addr = STORAGE_FLASH_OFFSET + block * STORAGE_BLOCK_SIZE;

    uint32_t ints = save_and_disable_interrupts();
    flash_range_erase(addr, STORAGE_BLOCK_SIZE);
    restore_interrupts(ints);

    return 0;
}

/**
 * LittleFS 同步回调。
 * RP2040 Flash 无独立同步机制，直接返回成功。
 */
static int lfs_sync_cb(const struct lfs_config *c)
{
    (void)c;
    return 0;
}

/* ========== LittleFS 配置结构体 ========== */

static struct lfs_config s_lfs_cfg = {
    .read           = lfs_read_cb,
    .prog           = lfs_prog_cb,
    .erase          = lfs_erase_cb,
    .sync           = lfs_sync_cb,
    .read_size      = 256,
    .prog_size      = 256,
    .block_size     = STORAGE_BLOCK_SIZE,
    .block_count    = STORAGE_BLOCK_COUNT,
    .cache_size     = STORAGE_CACHE_SIZE,
    .lookahead_size = STORAGE_LOOKAHEAD_SIZE,
    .block_cycles   = 500,
};

/* ========== 公共接口实现 ========== */

bool storage_hal_init(void)
{
    int err = lfs_mount(&g_lfs, &s_lfs_cfg);

    if (err != LFS_ERR_OK) {
        /* 挂载失败，尝试格式化 */
        err = lfs_format(&g_lfs, &s_lfs_cfg);
        if (err != LFS_ERR_OK) {
            return false;
        }
        err = lfs_mount(&g_lfs, &s_lfs_cfg);
        if (err != LFS_ERR_OK) {
            return false;
        }
    }

    g_lfs_mounted = true;

    /*
     * 清理可能存在的孤儿临时文件（上次写入中断电残留）。
     * LittleFS 的 copy-on-write 保证文件系统结构一致性，
     * 但不会主动删除用户创建的临时文件。
     * lfs_remove 对不存在的文件返回 LFS_ERR_NOENT，无害。
     */
    lfs_remove(&g_lfs, STORAGE_TMP_PATH);

    return true;
}

/* ========== 分步写入 ========== */

bool storage_hal_write_begin(void)
{
    if (!g_lfs_mounted) {
        return false;
    }
    if (g_write_file_open) {
        return false;  /* 不允许重入 */
    }

    int err = lfs_file_open(&g_lfs, &g_write_file, STORAGE_TMP_PATH,
                            LFS_O_WRONLY | LFS_O_CREAT | LFS_O_TRUNC);
    if (err != LFS_ERR_OK) {
        return false;
    }

    g_write_file_open = true;
    return true;
}

bool storage_hal_write_step(const uint8_t *data, size_t len)
{
    if (!g_write_file_open) {
        return false;
    }
    if (data == NULL || len == 0) {
        return false;
    }

    lfs_ssize_t written = lfs_file_write(&g_lfs, &g_write_file, data, len);
    return (written == (lfs_ssize_t)len);
}

bool storage_hal_write_finalize(void)
{
    if (!g_write_file_open) {
        return false;
    }

    /* 关闭临时文件，确保数据落盘 */
    int err = lfs_file_close(&g_lfs, &g_write_file);
    g_write_file_open = false;

    if (err != LFS_ERR_OK) {
        /*
         * close 失败：文件句柄可能处于不一致状态，不再尝试二次 close。
         * 尝试删除临时文件进行清理。若 remove 也失败（LittleFS 内部
         * 仍持有引用），残留文件由下次 storage_hal_init() 兜底清理。
         */
        lfs_remove(&g_lfs, STORAGE_TMP_PATH);
        return false;
    }

    /*
     * 原子替换：直接 rename。
     * lfs_rename 遵循 POSIX 语义：若目标文件 /cfg.bin 已存在，
     * 则原子覆盖。无需先 lfs_remove 旧文件。
     * 这消除了 remove→rename 之间的断电风险窗口。
     */
    err = lfs_rename(&g_lfs, STORAGE_TMP_PATH, STORAGE_CFG_PATH);
    if (err != LFS_ERR_OK) {
        /* rename 失败，临时文件残留，下次 init 时清理 */
        return false;
    }

    return true;
}

void storage_hal_write_cancel(void)
{
    if (g_write_file_open) {
        lfs_file_close(&g_lfs, &g_write_file);
        g_write_file_open = false;
    }
    if (g_lfs_mounted) {
        lfs_remove(&g_lfs, STORAGE_TMP_PATH);
    }
}

/* ========== 读取与删除 ========== */

bool storage_hal_read_file(uint8_t *buf, size_t max_len, size_t *out_len)
{
    if (!g_lfs_mounted) {
        return false;
    }
    if (buf == NULL || out_len == NULL || max_len == 0) {
        return false;
    }

    lfs_file_t file;
    int err = lfs_file_open(&g_lfs, &file, STORAGE_CFG_PATH, LFS_O_RDONLY);
    if (err != LFS_ERR_OK) {
        return false;
    }

    lfs_ssize_t rd = lfs_file_read(&g_lfs, &file, buf, max_len);
    lfs_file_close(&g_lfs, &file);

    if (rd < 0) {
        return false;
    }

    *out_len = (size_t)rd;
    return true;
}

bool storage_hal_remove_file(void)
{
    if (!g_lfs_mounted) {
        return false;
    }

    int err = lfs_remove(&g_lfs, STORAGE_CFG_PATH);
    /* LFS_ERR_NOENT 视为成功（文件本不存在） */
    return (err == LFS_ERR_OK || err == LFS_ERR_NOENT);
}
```

---

## 4. APP 层

### `pipelines/storage/storage_app.h`

```c
/**
 * @file storage_app.h
 * @brief Storage APP 层内部接口声明（调试/测试用）
 *
 * 本文件仅供调试和单元测试使用。
 * 正常业务代码应通过 market/storage_api.h 访问 Storage 管线。
 */

#ifndef STORAGE_APP_H
#define STORAGE_APP_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * 获取当前写入状态机状态（调试用）。
 * @return 状态枚举值（0=IDLE, 1=ACTIVE, 2=FINALIZING, 3=DONE, 4=FAILED）
 */
uint8_t storage_app_get_write_state(void);

/**
 * 获取 HAL 就绪状态（调试用）。
 * @return true HAL 已初始化且可用
 */
bool storage_app_is_hal_ready(void);

#ifdef __cplusplus
}
#endif

#endif /* STORAGE_APP_H */
```

### `pipelines/storage/storage_app.c`

```c
/**
 * @file storage_app.c
 * @brief Storage APP 层实现 — 业务逻辑入口
 *
 * 实现 market/storage_api.h 定义的全部 5 个公共接口。
 * 组合 CORE 层的算法能力和 HAL 层的存储原语，完成：
 * 1. 延迟初始化（Lazy Init）
 * 2. 分步写入状态机与进度管理
 * 3. Header 的自动组装与剥离
 * 4. CRC 校验的触发与判定
 * 5. 错误场景的统一处理
 */

#include "storage_hal.h"
#include "storage_core.h"
#include "market/storage_api.h"

#include <string.h>
#include <assert.h>

/* ========== 配置常量（产品特有，APP 层定义） ========== */

/** 最大 Payload 字节数 */
#define STORAGE_MAX_PAYLOAD_LEN  512u

/** 每步写入字节数（逻辑步长，非 Flash 页大小） */
#define STORAGE_STEP_SIZE        256u

/* ========== 写入状态机 ========== */

typedef enum {
    WRITE_IDLE = 0,      /* 无活跃写入会话 */
    WRITE_ACTIVE,        /* 分步数据写入进行中 */
    WRITE_FINALIZING,    /* 数据已写完，等待执行 finalize（rename） */
    WRITE_DONE,          /* 写入成功完成 */
    WRITE_FAILED         /* 写入失败（已自动清理） */
} write_state_t;

/* ========== 帧缓冲区（静态分配，load 与 save 复用） ========== */

/**
 * 复用安全论证：
 * 1. load 在 cmd_cfg_init() 中调用（上电阶段，loop() 之前）。
 * 2. save 在 cmd_cfg_task() 中调用（loop() 运行时）。
 * 3. save 完成后，cmd_cfg_task() 立即调用 load 进行回读验证。
 *    此时 s_frame_buf 中残留 save 的帧数据，但 load 会通过
 *    storage_hal_read_file() 完全重写 s_frame_buf，不依赖
 *    其中残留的任何内容。因此即使在同一主循环轮次内连续调用
 *    save_step → load，也是安全的。
 * 4. 单核无抢占模型下不存在并发访问。
 */
static uint8_t s_frame_buf[STORAGE_HDR_SIZE + STORAGE_MAX_PAYLOAD_LEN];

/* ========== 写入进度（APP 层管理） ========== */

static size_t s_write_offset;      /* 当前写入偏移 */
static size_t s_write_total_len;   /* 帧总长度（Header + Payload） */

/* ========== 写入状态机 ========== */

static write_state_t s_write_state = WRITE_IDLE;

/* ========== 初始化标志 ========== */

static bool s_initialized = false;
static bool s_hal_ready   = false;

/* ========== 延迟初始化 ========== */

/**
 * 确保 Storage 子系统已初始化。
 * 首次调用时执行 HAL 初始化，后续调用直接返回缓存结果。
 * 线程安全：单核无抢占模型下无需保护。
 */
static bool ensure_initialized(void)
{
    if (!s_initialized) {
        s_hal_ready   = storage_hal_init();
        s_initialized = true;
    }
    return s_hal_ready;
}

/* ========== 公共接口实现 ========== */

bool storage_save_config_begin(const uint8_t *data, size_t len)
{
    /* 前置检查 */
    if (!ensure_initialized()) {
        return false;
    }
    if (data == NULL || len == 0 || len > STORAGE_MAX_PAYLOAD_LEN) {
        return false;
    }
    if (s_write_state == WRITE_ACTIVE || s_write_state == WRITE_FINALIZING) {
        return false;  /* 不允许重入 */
    }

    /*
     * 步骤 1：先打开 HAL 写入会话。
     * 将 HAL 操作放在帧构建之前，确保 HAL 打开失败时
     * 不修改任何内部状态（帧缓冲区、进度变量），
     * 遵循"失败时不修改任何状态"的防御性原则。
     */
    if (!storage_hal_write_begin()) {
        return false;
    }

    /* 步骤 2：构建 Header */
    storage_header_t hdr;
    storage_header_build(data, (uint16_t)len, &hdr);

    /* 步骤 3：序列化 Header 到帧缓冲区 */
    storage_header_serialize(&hdr, s_frame_buf);

    /* 步骤 4：拷贝 Payload 到帧缓冲区 */
    memcpy(&s_frame_buf[STORAGE_HDR_SIZE], data, len);

    /* 步骤 5：初始化写入进度 */
    s_write_total_len = STORAGE_HDR_SIZE + len;
    s_write_offset    = 0;

    /* 步骤 6：切换状态 */
    s_write_state = WRITE_ACTIVE;

    return true;
}

bool storage_save_config_step(void)
{
    switch (s_write_state) {

    case WRITE_ACTIVE: {
        /* 计算本步写入范围 */
        size_t remaining = s_write_total_len - s_write_offset;
        size_t step_len  = (remaining > STORAGE_STEP_SIZE)
                           ? STORAGE_STEP_SIZE : remaining;

        /* 调用 HAL 写入当前步数据 */
        bool ok = storage_hal_write_step(
            &s_frame_buf[s_write_offset], step_len);

        if (!ok) {
            /* 写入失败：清理并标记失败 */
            storage_hal_write_cancel();
            s_write_state = WRITE_FAILED;
            return true;  /* 会话结束（失败） */
        }

        s_write_offset += step_len;

        /* 检查数据是否全部写完 */
        if (s_write_offset >= s_write_total_len) {
            /* 数据写完，进入 FINALIZING 状态，推迟到下一步执行 */
            s_write_state = WRITE_FINALIZING;
            return false;  /* 还有一步（finalize） */
        }

        return false;  /* 还有剩余数据 */
    }

    case WRITE_FINALIZING: {
        /* 执行原子替换（close + rename） */
        bool ok = storage_hal_write_finalize();

        if (ok) {
            s_write_state = WRITE_DONE;
        } else {
            s_write_state = WRITE_FAILED;
        }

        return true;  /* 会话结束 */
    }

    case WRITE_IDLE:
    case WRITE_DONE:
    case WRITE_FAILED:
    default:
        /*
         * 防御性行为：非活跃状态下不应到达此处。
         * 返回 true 以终止调用者的步进循环，避免无限等待。
         * 调试构建中触发断言以帮助定位状态机驱动错误。
         */
        assert(false && "storage_save_config_step() called in non-active state");
        return true;
    }
}

void storage_save_config_abort(void)
{
    if (s_write_state == WRITE_ACTIVE || s_write_state == WRITE_FINALIZING) {
        storage_hal_write_cancel();
    }
    s_write_state = WRITE_IDLE;
}

bool storage_load_config(uint8_t *buf, size_t max_len, size_t *out_len)
{
    if (!ensure_initialized()) {
        return false;
    }
    if (buf == NULL || out_len == NULL || max_len == 0) {
        return false;
    }

    /* 1. 从 HAL 读取完整文件（Header + Payload）到帧缓冲区 */
    size_t raw_len = 0;
    if (!storage_hal_read_file(s_frame_buf, sizeof(s_frame_buf), &raw_len)) {
        return false;  /* 文件不存在或读取错误 */
    }

    /* 2. 最小长度检查 */
    if (raw_len < STORAGE_HDR_SIZE) {
        return false;
    }

    /* 3. 反序列化 Header */
    storage_header_t hdr;
    storage_header_deserialize(s_frame_buf, &hdr);

    /* 4. 提取 Payload 长度并校验范围 */
    uint16_t payload_len = hdr.payload_len;
    if (payload_len == 0 || payload_len > STORAGE_MAX_PAYLOAD_LEN) {
        return false;
    }
    if (raw_len < (size_t)(STORAGE_HDR_SIZE + payload_len)) {
        return false;  /* 文件截断 */
    }

    const uint8_t *payload = &s_frame_buf[STORAGE_HDR_SIZE];

    /* 5. 验证 Header（含 CRC 校验） */
    if (!storage_header_validate(&hdr, payload, payload_len)) {
        return false;
    }

    /* 6. 拷贝 Payload 到调用者缓冲区 */
    if (payload_len > max_len) {
        return false;  /* 调用者缓冲区不足 */
    }

    memcpy(buf, payload, payload_len);
    *out_len = payload_len;

    return true;
}

bool storage_erase_config(void)
{
    if (!ensure_initialized()) {
        return false;
    }

    /* 若正在写入，先中止 */
    if (s_write_state == WRITE_ACTIVE || s_write_state == WRITE_FINALIZING) {
        storage_save_config_abort();
    }

    return storage_hal_remove_file();
}

/* ========== 调试/测试接口 ========== */

uint8_t storage_app_get_write_state(void)
{
    return (uint8_t)s_write_state;
}

bool storage_app_is_hal_ready(void)
{
    return s_hal_ready;
}
```

---

## 5. 文件结构总览

```
firmware/
├── market/
│   └── storage_api.h              ← 跨管线公共契约
├── pipelines/
│   └── storage/
│       ├── storage_core.h         ← CORE 层接口（纯算法）
│       ├── storage_core.c         ← CRC-32 + Header 编解码
│       ├── storage_hal.h          ← HAL 层接口（仅供 APP 包含）
│       ├── storage_hal.c          ← LittleFS + RP2040 Flash 适配
│       ├── storage_app.h          ← APP 层内部接口（调试/测试）
│       └── storage_app.c          ← 业务逻辑（实现 storage_api.h）
└── ...
```

---

## 6. 关键设计决策摘要

| 决策 | 理由 |
|------|------|
| **Lazy Init** | 架构文档 §9 禁止 `main` 依赖 `storage_api`，不得在 `setup()` 中显式初始化 |
| **begin() 中先 HAL 后帧构建** | 遵循"失败时不修改任何状态"原则（v1.3 审计 N-10） |
| **WRITE_FINALIZING 独立状态** | 将 `lfs_rename`（最坏 ~45ms）隔离为独立步骤，满足 ADR-005 每步 <5ms |
| **直接 `lfs_rename` 不先 `lfs_remove`** | 消除 remove→rename 之间的断电风险窗口（v1.2 审计 N-02） |
| **静态 `s_frame_buf` 复用** | 避免栈上 528 字节数组，单核无抢占模型下 load/save 复用安全 |
| **CRC-32 编译期常量表** | 消除运行时初始化尖峰，1KB Flash 开销可忽略 |
| **回读验证而非内部标志** | 不修改冻结的 5 函数市场 API，验证端到端数据完整性 |
| **CORE 层零产品假设** | `STORAGE_MAX_PAYLOAD_LEN` 定义在 APP 层，CORE 层可跨产品复用 |

---

## 7. 编译依赖说明

| 文件 | 依赖 |
|------|------|
| `storage_core.c` | 仅 `<stdint.h>`, `<stddef.h>`, `<stdbool.h>` |
| `storage_hal.c` | `lfs.h`, `hardware/flash.h`, `hardware/sync.h`, `<string.h>` |
| `storage_app.c` | `storage_hal.h`, `storage_core.h`, `market/storage_api.h`, `<string.h>`, `<assert.h>` |

构建系统需确保：
- `pipelines/storage/` 目录仅供本管线内部使用
- `market/` 作为全局公共包含路径
- `storage_hal.c` 链接 LittleFS 库和 Pico SDK
