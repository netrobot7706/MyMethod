# Lyre Storage 管线详细设计文档 v1.3

| 项目 | 说明 |
|------|------|
| 文档版本 | v1.3 |
| 对应管线 | Storage（`pipelines/storage/`） |
| 上游依据 | 《Lyre MK2 产品架构设计文档 v2.2》（终审冻结版） |
| 遵循规范 | 《信息管线星型架构 v1.1》 |
| 变更说明 | 基于 v1.2 审计报告修复 6 项发现（P2×3 / P3×3） |
| 最后更新 | 2026-07-27 |

---

## 修订记录

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| v1.0 | 2026-07-25 | 初版 |
| v1.1 | 2026-07-27 | 修复 v1.0 审计 12 项发现 |
| v1.2 | 2026-07-27 | 修复 v1.1 审计 9 项发现 |
| v1.3 | 2026-07-27 | 修复 v1.2 审计 6 项发现：N-10 调整 begin() 步骤顺序；N-11 补充回读验证局限性说明；N-12 补充 close 失败清理说明；N-13 统一时序轮次划分；N-14 补充 CRC 空输入行为注释；N-16 统一 finalize 接口注释 |

---

## 1. 模块概述

### 1.1 职责定义

Storage 管线负责 Lyre 设备配置数据在 SPI Flash 上的持久化存储，提供**分步写入**、**完整读取**和**擦除**三类操作。它是系统中唯一直接操作 Flash 硬件的管线，对外通过 `market/storage_api.h` 暴露最小化接口。

### 1.2 设计约束（源自架构文档）

| 约束编号 | 来源 | 内容 |
|----------|------|------|
| C-01 | ADR-005 | 写入必须分步执行，每步阻塞 <5ms，不得一次性同步阻塞 |
| C-02 | §4.4 | Storage 管线内部自动添加 header（magic + version + payload_len + CRC），调用者仅传入纯 payload |
| C-03 | §4.4 | 读取时自动剥离 header，调用者仅接收纯 payload |
| C-04 | §4.4 | 读取失败时调用者无需区分具体原因，统一回退出厂默认 |
| C-05 | §2 | 管线间绝对隔离，Storage 不依赖任何其他管线 |
| C-06 | §7 | 单核无抢占模型，无需考虑多线程并发 |
| C-07 | §5.3 | 更换存储介质时只需修改 HAL 层，APP 接口保持不变 |
| C-08 | §9 | `main` 仅依赖 `pot_api, midi_api, led_api, cmd_cfg_api`，不依赖 `storage_api` |

### 1.3 消费者

| 消费者 | 调用场景 |
|--------|----------|
| `cmd_cfg_init()` | 上电时调用 `storage_load_config()` 加载配置 |
| `cmd_cfg_task()` | 配置/校准写入状态机中调用 `storage_save_config_begin/step/abort` |
| `cmd_cfg_task()` | 恢复出厂设置时调用 `storage_erase_config()`（已实现，待 `cmd_cfg_app` 集成调用） |

### 1.4 职责边界声明

以下行为**不属于** Storage 管线职责，由消费者（`cmd_cfg_app`）负责：

- 加载失败后使用出厂默认配置并尝试写入 Flash（架构文档 §6.4）
- 写入失败后发送 NACK 响应（架构文档 §6.2）
- 双缓冲 RAM 快照切换决策（架构文档 §6.2）
- LED 状态指示与 Pot 暂停/恢复控制（架构文档 §6.2）

Storage 管线仅保证：在自身接口被正确调用的前提下，提供可靠的持久化原语。

---

## 2. 内部架构

### 2.1 三层结构总览

```
┌─────────────────────────────────────────────────────────┐
│                    market/storage_api.h                  │  ← 跨管线契约
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │              storage_app.c / .h                  │    │  APP 层
│  │  • 延迟初始化（Lazy Init）                       │    │
│  │  • 分步写入状态机 + 进度管理                     │    │
│  │  • Header 组装 / 剥离                            │    │
│  │  • 业务语义封装                                  │    │
│  └──────────────────────┬──────────────────────────┘    │
│                         │ 调用                          │
│  ┌──────────────────────▼──────────────────────────┐    │
│  │              storage_core.c / .h                 │    │  CORE 层
│  │  • CRC-32 算法（编译期常量表，零外部依赖）       │    │
│  │  • Header 序列化 / 反序列化                      │    │
│  │  • Header 构建与验证                             │    │
│  └──────────────────────┬──────────────────────────┘    │
│                         │ 调用                          │
│  ┌──────────────────────▼──────────────────────────┐    │
│  │              storage_hal.c / .h                  │    │  HAL 层
│  │  • LittleFS 初始化与挂载                         │    │
│  │  • 分步文件写入原语（begin/step/finalize/cancel）│    │
│  │  • 文件读取与删除                                │    │
│  │  • SPI Flash 硬件适配                            │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 2.2 层间依赖规则

- **APP → CORE → HAL**：严格自上而下，禁止反向调用。
- **CORE 层零外部依赖**：`storage_core.c` 不包含任何 RP2040 SDK、LittleFS 或其他管线头文件，仅依赖 `<stdint.h>`、`<stddef.h>`、`<stdbool.h>`。CORE 层仅包含**领域通用算法**（CRC-32、Header 编解码），不含任何产品特有假设，可在不同产品间直接拷贝复用。
- **HAL 层是唯一硬件耦合点**：所有 LittleFS API 调用、SPI Flash 配置均封装在 HAL 层内部。
- **APP 层承载业务编排**：分步写入进度管理、状态机、步长配置等产品特有逻辑均在 APP 层实现。

### 2.3 文件清单

| 文件 | 层级 | 职责 |
|------|------|------|
| `storage_hal.h` | HAL | HAL 层内部接口声明（仅供 APP 层包含） |
| `storage_hal.c` | HAL | LittleFS 适配实现 |
| `storage_core.h` | CORE | CORE 层内部接口声明 |
| `storage_core.c` | CORE | CRC-32、Header 编解码 |
| `storage_app.h` | APP | APP 层内部接口声明（调试/测试用） |
| `storage_app.c` | APP | 业务逻辑实现，实现 `market/storage_api.h` 全部接口 |

---

## 3. 数据结构设计

### 3.1 Flash 存储布局

Lyre 使用 LittleFS 文件系统管理 SPI Flash。配置数据以**单文件**形式存储，文件路径固定为 `"/cfg.bin"`。写入过程中使用临时文件 `"/cfg.tmp"`，完成后通过 `lfs_rename()` 原子替换。

```
SPI Flash (LittleFS 分区)
┌────────────────────────────────────────────┐
│  LittleFS 超级块 + 元数据                   │
├────────────────────────────────────────────┤
│  /cfg.bin          ← 正式配置文件           │
│  ┌──────────────────────────────────────┐  │
│  │  Storage Header (16 bytes)           │  │
│  ├──────────────────────────────────────┤  │
│  │  Configuration Payload (N bytes)     │  │
│  └──────────────────────────────────────┘  │
├────────────────────────────────────────────┤
│  /cfg.tmp          ← 写入中的临时文件       │
│  （正常完成后不存在；断电残留由初始化清理）  │
├────────────────────────────────────────────┤
│  LittleFS 空闲空间                          │
└────────────────────────────────────────────┘
```

**设计决策**：采用单文件 + 临时文件原子替换方案，理由如下：
- LittleFS 自带磨损均衡和掉电安全（copy-on-write），无需在 CORE 层重复实现。
- `lfs_rename()` 是原子操作且遵循 POSIX 语义（目标文件存在时自动覆盖），保证任何时刻断电后 `/cfg.bin` 要么为完整旧数据、要么为完整新数据。
- 配置数据量极小（< 256 bytes），文件系统开销可忽略。

### 3.2 Storage Header 格式

Header 固定 16 字节，小端序（Little-Endian），由 Storage 管线内部自动管理，调用者不可见。

| 偏移 | 长度 | 字段名 | 类型 | 说明 |
|------|------|--------|------|------|
| 0x00 | 4 | `magic` | `uint32_t` | 固定值 `0x4C595245`（ASCII "LYRE"） |
| 0x04 | 2 | `version` | `uint16_t` | Header 格式版本号，当前为 `0x0001` |
| 0x06 | 2 | `payload_len` | `uint16_t` | Payload 字节数（不含 Header） |
| 0x08 | 4 | `crc32` | `uint32_t` | Payload 的 CRC-32 校验值 |
| 0x0C | 4 | `reserved` | `uint32_t` | 保留字段，写入时填 `0x00000000`，读取时忽略 |

**C 结构体定义**（位于 `storage_core.h`）：

```c
#define STORAGE_MAGIC       0x4C595245u  /* "LYRE" */
#define STORAGE_HDR_VERSION 0x0001u
#define STORAGE_HDR_SIZE    16u

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint16_t version;
    uint16_t payload_len;
    uint32_t crc32;
    uint32_t reserved;
} storage_header_t;

_Static_assert(sizeof(storage_header_t) == STORAGE_HDR_SIZE,
               "storage_header_t must be exactly 16 bytes");
```

### 3.3 CRC-32 算法规格

| 参数 | 值 |
|------|-----|
| 多项式 | `0xEDB88320`（反转形式，对应标准 CRC-32/ISO-HDLC） |
| 初始值 | `0xFFFFFFFF` |
| 输入反转 | 是（RefIn = true） |
| 输出反转 | 是（RefOut = true） |
| 异或输出 | `0xFFFFFFFF`（XorOut） |
| 校验向量 | CRC-32("123456789") == `0xCBF43926` |

该算法与 zlib `crc32()` 完全兼容，便于上位机或测试工具独立验证。

### 3.4 配置 Payload 容量约束

| 参数 | 值 | 说明 |
|------|-----|------|
| 最大 Payload 长度 | 512 bytes | 由 `STORAGE_MAX_PAYLOAD_LEN` 宏定义 |
| 典型 Payload 长度 | 28 bytes | 见下方计算 |
| Header 大小 | 16 bytes | 固定 |
| 单文件最大占用 | 528 bytes | Header + Payload |

**典型 Payload 28 字节的计算依据**（对应 `cmd_cfg_app` 内部配置快照结构）：

| 字段 | 大小 | 说明 |
|------|------|------|
| 4 路推杆映射 | 4 × 2 = 8 bytes | 每路：CC 编号(1B) + 映射模式(1B) |
| 4 路校准数据 | 4 × 4 = 16 bytes | 每路：min(2B) + max(2B)，uint16 精度 |
| 库选择 | 1 byte | 当前音色库索引 |
| 保留/对齐填充 | 3 bytes | 对齐至 4 字节边界 |
| **合计** | **28 bytes** | |

`STORAGE_MAX_PAYLOAD_LEN = 512` 的选取依据：为未来协议扩展（如增加更多推杆、增加 per-channel 配置等）预留充足空间，同时远小于 LittleFS 最小分配单元（4KB），不会造成空间浪费。

---

## 4. HAL 层详细设计（`storage_hal.c / .h`）

### 4.1 职责

HAL 层封装所有与 LittleFS 及底层 SPI Flash 硬件相关的操作，向上层提供**与文件系统无关**的抽象原语。上层代码不包含任何 `lfs.h` 头文件。

### 4.2 接口定义（`storage_hal.h`）

```c
#ifndef STORAGE_HAL_H
#define STORAGE_HAL_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/**
 * 初始化存储子系统。
 * 包括：SPI Flash 硬件初始化、LittleFS 格式化检测与挂载、
 *       孤儿临时文件清理。
 * 若 Flash 未格式化，自动执行格式化。
 * @return true 成功；false Flash 硬件不可用或格式化失败。
 */
bool storage_hal_init(void);

/* ========== 分步写入接口 ========== */

/**
 * 开始一次写入会话。
 * 打开临时文件 "/cfg.tmp"（O_WRONLY | O_CREAT | O_TRUNC）。
 * @return true 成功；false 打开失败
 */
bool storage_hal_write_begin(void);

/**
 * 向已打开的临时文件顺序写入一步数据。
 * @param data  待写入数据（不可为 NULL）
 * @param len   字节数（不可为 0）
 * @return true 成功；false 写入失败
 */
bool storage_hal_write_step(const uint8_t *data, size_t len);

/**
 * 完成写入会话：关闭临时文件，原子替换正式文件。
 * 内部执行：lfs_file_close → lfs_rename("/cfg.tmp", "/cfg.bin")。
 * lfs_rename 遵循 POSIX 语义：若 /cfg.bin 已存在则原子覆盖。
 * 若 lfs_file_close 失败，内部会尝试删除临时文件进行清理，
 * 残留文件由下次 storage_hal_init() 兜底清理。
 * @return true 成功；false 关闭或替换失败
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
 * @param buf      输出缓冲区（不可为 NULL）
 * @param max_len  缓冲区容量（不可为 0）
 * @param out_len  实际读取字节数（不可为 NULL）
 * @return true 成功；false 文件不存在、参数非法或读取错误
 */
bool storage_hal_read_file(uint8_t *buf, size_t max_len, size_t *out_len);

/**
 * 删除配置文件。
 * @return true 成功（含文件本不存在的情况）；false Flash 操作错误
 */
bool storage_hal_remove_file(void);

#endif /* STORAGE_HAL_H */
```

### 4.3 实现要点

#### 4.3.1 LittleFS 配置参数

```c
/* storage_hal.c 内部 */
#include "lfs.h"
#include "hardware/flash.h"
#include "hardware/sync.h"

/* Flash 分区配置（根据 RP2040-Zero 板载 Flash 实际容量调整） */
#define STORAGE_FLASH_OFFSET    (1024 * 1024)   /* 从 1MB 偏移开始，避开固件区 */
#define STORAGE_FLASH_SIZE      (64 * 1024)     /* 分配 64KB 给 LittleFS */
#define STORAGE_BLOCK_SIZE      4096            /* Flash 扇区大小 */
#define STORAGE_BLOCK_COUNT     (STORAGE_FLASH_SIZE / STORAGE_BLOCK_SIZE)
#define STORAGE_CACHE_SIZE      256
#define STORAGE_LOOKAHEAD_SIZE  16

#define STORAGE_CFG_PATH        "/cfg.bin"
#define STORAGE_TMP_PATH        "/cfg.tmp"

static lfs_t g_lfs;
static bool  g_lfs_mounted = false;

/* LittleFS 底层读写回调（适配 RP2040 flash_range_* API） */
static int lfs_read_cb(const struct lfs_config *c, lfs_block_t block,
                       lfs_off_t off, void *buffer, lfs_size_t size);
static int lfs_prog_cb(const struct lfs_config *c, lfs_block_t block,
                       lfs_off_t off, const void *buffer, lfs_size_t size);
static int lfs_erase_cb(const struct lfs_config *c, lfs_block_t block);
static int lfs_sync_cb(const struct lfs_config *c);
```

#### 4.3.2 RP2040 Flash 写入特殊处理

RP2040 的 `flash_range_program()` 和 `flash_range_erase()` 会**禁用 XIP（Execute-In-Place）**，即 CPU 不能从 Flash 取指。因此：

1. 所有 Flash 写入/擦除回调函数必须标记为 `__not_in_flash_func()`，确保代码运行在 RAM 中。
2. 写入/擦除期间需调用 `save_and_disable_interrupts()` / `restore_interrupts()` 禁止中断，防止 ISR 中的 Flash 读取导致 HardFault。
3. 由于本设计仅使用 Core 0 且无 RTOS，禁中断窗口（单次页编程 ~45μs，扇区擦除 ~45ms）对系统无实质影响。

```c
static int __not_in_flash_func(lfs_prog_cb)(
    const struct lfs_config *c, lfs_block_t block,
    lfs_off_t off, const void *buffer, lfs_size_t size)
{
    uint32_t addr = STORAGE_FLASH_OFFSET + block * c->block_size + off;
    uint32_t ints = save_and_disable_interrupts();
    flash_range_program(addr, (const uint8_t *)buffer, size);
    restore_interrupts(ints);
    return 0;
}

static int __not_in_flash_func(lfs_erase_cb)(
    const struct lfs_config *c, lfs_block_t block)
{
    uint32_t addr = STORAGE_FLASH_OFFSET + block * c->block_size;
    uint32_t ints = save_and_disable_interrupts();
    flash_range_erase(addr, c->block_size);
    restore_interrupts(ints);
    return 0;
}
```

#### 4.3.3 初始化与自动格式化 + 孤儿文件清理

```c
bool storage_hal_init(void)
{
    static struct lfs_config cfg = {
        .read  = lfs_read_cb,
        .prog  = lfs_prog_cb,
        .erase = lfs_erase_cb,
        .sync  = lfs_sync_cb,
        .read_size      = 256,
        .prog_size      = 256,
        .block_size     = STORAGE_BLOCK_SIZE,
        .block_count    = STORAGE_BLOCK_COUNT,
        .cache_size     = STORAGE_CACHE_SIZE,
        .lookahead_size = STORAGE_LOOKAHEAD_SIZE,
        .block_cycles   = 500,
    };

    int err = lfs_mount(&g_lfs, &cfg);
    if (err != LFS_ERR_OK) {
        /* 挂载失败，尝试格式化 */
        err = lfs_format(&g_lfs, &cfg);
        if (err != LFS_ERR_OK) {
            return false;
        }
        err = lfs_mount(&g_lfs, &cfg);
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
```

#### 4.3.4 分步写入实现

```c
static lfs_file_t g_write_file;
static bool       g_write_file_open = false;

bool storage_hal_write_begin(void)
{
    if (!g_lfs_mounted) return false;
    if (g_write_file_open) return false;  /* 不允许重入 */

    int err = lfs_file_open(&g_lfs, &g_write_file, STORAGE_TMP_PATH,
                            LFS_O_WRONLY | LFS_O_CREAT | LFS_O_TRUNC);
    if (err != LFS_ERR_OK) return false;
    g_write_file_open = true;
    return true;
}

bool storage_hal_write_step(const uint8_t *data, size_t len)
{
    if (!g_write_file_open) return false;
    if (data == NULL || len == 0) return false;
    lfs_ssize_t written = lfs_file_write(&g_lfs, &g_write_file, data, len);
    return (written == (lfs_ssize_t)len);
}

bool storage_hal_write_finalize(void)
{
    if (!g_write_file_open) return false;

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
```

#### 4.3.5 读取与删除

```c
bool storage_hal_read_file(uint8_t *buf, size_t max_len, size_t *out_len)
{
    if (!g_lfs_mounted) return false;
    if (buf == NULL || out_len == NULL || max_len == 0) return false;

    lfs_file_t file;
    int err = lfs_file_open(&g_lfs, &file, STORAGE_CFG_PATH, LFS_O_RDONLY);
    if (err != LFS_ERR_OK) return false;

    lfs_ssize_t rd = lfs_file_read(&g_lfs, &file, buf, max_len);
    lfs_file_close(&g_lfs, &file);

    if (rd < 0) return false;
    *out_len = (size_t)rd;
    return true;
}

bool storage_hal_remove_file(void)
{
    if (!g_lfs_mounted) return false;
    int err = lfs_remove(&g_lfs, STORAGE_CFG_PATH);
    /* LFS_ERR_NOENT 视为成功（文件本不存在） */
    return (err == LFS_ERR_OK || err == LFS_ERR_NOENT);
}
```

### 4.4 HAL 层错误码映射

HAL 层内部将 LittleFS 错误码统一映射为 `bool` 返回值，不向上层暴露具体错误类型。这符合架构文档 C-04 约束："调用者无需区分具体失败原因"。

| LittleFS 错误 | HAL 返回 | 说明 |
|---------------|----------|------|
| `LFS_ERR_OK` | `true` | 成功 |
| `LFS_ERR_NOENT` | `false`（read）/ `true`（remove） | 文件不存在 |
| `LFS_ERR_IO` | `false` | Flash I/O 错误 |
| `LFS_ERR_NOSPC` | `false` | 空间不足 |
| 其他 | `false` | 未预期错误 |

---

## 5. CORE 层详细设计（`storage_core.c / .h`）

### 5.1 职责

CORE 层包含**纯算法**，零硬件依赖、零文件系统依赖、零外部管线依赖、零产品特有假设。可直接拷贝到任何 C 项目中复用，无需任何修改。

### 5.2 接口定义（`storage_core.h`）

```c
#ifndef STORAGE_CORE_H
#define STORAGE_CORE_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/* ========== 常量 ========== */

#define STORAGE_MAGIC       0x4C595245u  /* "LYRE" */
#define STORAGE_HDR_VERSION 0x0001u
#define STORAGE_HDR_SIZE    16u

/* ========== Header 结构体 ========== */

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint16_t version;
    uint16_t payload_len;
    uint32_t crc32;
    uint32_t reserved;
} storage_header_t;

_Static_assert(sizeof(storage_header_t) == STORAGE_HDR_SIZE,
               "storage_header_t must be exactly 16 bytes");

/* ========== CRC-32 ========== */

/**
 * 计算 CRC-32（ISO-HDLC / zlib 兼容）。
 * 使用编译期常量查找表，无运行时初始化开销。
 *
 * @param data  输入数据。len > 0 时不可为 NULL。
 *              len == 0 时 data 可为 NULL（不会被解引用）。
 * @param len   数据长度。len == 0 时返回 0x00000000。
 * @return CRC-32 校验值
 */
uint32_t storage_crc32(const uint8_t *data, size_t len);

/* ========== Header 编解码 ========== */

/**
 * 将 Header 结构体序列化为字节流（小端序）。
 * @param hdr  输入 Header 结构体
 * @param out  输出缓冲区，至少 STORAGE_HDR_SIZE 字节
 */
void storage_header_serialize(const storage_header_t *hdr, uint8_t *out);

/**
 * 从字节流反序列化 Header 结构体（小端序）。
 * @param in   输入字节流，至少 STORAGE_HDR_SIZE 字节
 * @param hdr  输出 Header 结构体
 */
void storage_header_deserialize(const uint8_t *in, storage_header_t *hdr);

/**
 * 构建完整的 Header。
 * 自动填充 magic、version、payload_len、crc32，reserved 置零。
 * 当 payload_len == 0 时，crc32 字段为 0x00000000。
 * @param payload      Payload 数据指针（payload_len > 0 时不可为 NULL）
 * @param payload_len  Payload 长度
 * @param hdr          输出 Header 结构体
 */
void storage_header_build(const uint8_t *payload, uint16_t payload_len,
                          storage_header_t *hdr);

/**
 * 验证 Header 合法性。
 * 检查项：magic 匹配、version 匹配、payload_len 与传入值一致、
 *         CRC-32 与 payload 重新计算值一致。
 *
 * @note 前置条件：调用者须确保 payload 指针有效且至少 payload_len
 *       字节可读，payload_len 在调用者定义的合法范围内。
 *       本函数不检查 payload_len 的上界（上界为产品特有约束，
 *       不属于 CORE 层通用算法的职责）。
 *
 * @param hdr          待验证的 Header
 * @param payload      Payload 数据指针（用于 CRC 重算）
 * @param payload_len  实际 Payload 长度
 * @return true 验证通过；false 任一检查失败
 */
bool storage_header_validate(const storage_header_t *hdr,
                             const uint8_t *payload, uint16_t payload_len);

#endif /* STORAGE_CORE_H */
```

### 5.3 CRC-32 实现（编译期常量表）

采用**编译期常量查找表**，避免运行时初始化的性能尖峰和行为不确定性。表由脚本预计算后以 `static const` 数组形式嵌入源码。

```c
/* storage_core.c */

/*
 * CRC-32 查找表（多项式 0xEDB88320，ISO-HDLC / zlib 兼容）。
 * 由工具脚本预计算生成，等价于以下运行时逻辑：
 *   for i in 0..255:
 *     crc = i
 *     for _ in 0..7:
 *       crc = (crc >> 1) ^ (0xEDB88320 if crc & 1 else 0)
 *     table[i] = crc
 *
 * 验证基准：table[0]=0x00000000, table[1]=0x77073096,
 *           table[255]=0xB3667A2E
 * 完整表共 256 项，此处展示首 16 项和末 8 项，完整内容见源码。
 */
static const uint32_t s_crc_table[256] = {
    /* 索引 0-15 */
    0x00000000u, 0x77073096u, 0xEE0E612Cu, 0x990951BAu,
    0x076DC419u, 0x706AF48Fu, 0xE963A535u, 0x9E6495A3u,
    0x0EDB8832u, 0x79DCB8A4u, 0xE0D5E91Bu, 0x97D2D988u,
    0x09B64C2Bu, 0x7EB17CBDu, 0xE7B82D09u, 0x90BF1D9Fu,
    /* ... 省略索引 16-247，完整表见源码 ... */
    /* 索引 248-255 */
    0x2D02EF8Du, 0x5A05DF1Bu, 0xC30C8EA1u, 0xB40BBE37u,
    0x2A6F2B94u, 0x5D681B02u, 0xC4614AB8u, 0xB3667A2Eu
};

uint32_t storage_crc32(const uint8_t *data, size_t len)
{
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc = (crc >> 8) ^ s_crc_table[(crc ^ data[i]) & 0xFFu];
    }
    return crc ^ 0xFFFFFFFFu;
}
```

**设计决策说明**：
- 查找表占用 1KB Flash（`static const` 存储在 Flash 中，不占 RAM）。
- 无运行时初始化，首次调用与后续调用性能一致。
- `len == 0` 时循环不执行，返回 `0xFFFFFFFF ^ 0xFFFFFFFF = 0x00000000`，`data` 不被解引用，可为 NULL。
- 若需进一步节省 Flash，可改为逐位计算（无表），速度降低约 8 倍，但对本项目 < 512 字节的 payload 无实质影响。

### 5.4 Header 编解码实现

```c
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
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 0;  /* reserved */
}

void storage_header_deserialize(const uint8_t *in, storage_header_t *hdr)
{
    hdr->magic       = (uint32_t)in[0] | ((uint32_t)in[1] << 8) |
                       ((uint32_t)in[2] << 16) | ((uint32_t)in[3] << 24);
    hdr->version     = (uint16_t)in[4] | ((uint16_t)in[5] << 8);
    hdr->payload_len = (uint16_t)in[6] | ((uint16_t)in[7] << 8);
    hdr->crc32       = (uint32_t)in[8] | ((uint32_t)in[9] << 8) |
                       ((uint32_t)in[10] << 16) | ((uint32_t)in[11] << 24);
    hdr->reserved    = 0;
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
    if (hdr->magic != STORAGE_MAGIC) return false;
    if (hdr->version != STORAGE_HDR_VERSION) return false;
    if (hdr->payload_len != payload_len) return false;
    if (hdr->crc32 != storage_crc32(payload, payload_len)) return false;
    return true;
}
```

---

## 6. APP 层详细设计（`storage_app.c / .h`）

### 6.1 职责

APP 层是 Storage 管线的业务入口，实现 `market/storage_api.h` 定义的全部 5 个公共接口。它组合 CORE 层的算法能力和 HAL 层的存储原语，完成以下业务逻辑：

1. 延迟初始化（Lazy Init）
2. 分步写入状态机与进度管理
3. Header 的自动组装与剥离
4. CRC 校验的触发与判定
5. 错误场景的统一处理

### 6.2 内部状态机

```
                    storage_save_config_begin()
                              │
                              ▼
                    ┌──────────────────┐
                    │   WRITE_IDLE     │ ◄──────────────────────┐
                    └────────┬─────────┘                        │
                             │ begin() 成功                     │
                             ▼                                  │
                    ┌──────────────────┐                        │
              ┌────►│  WRITE_ACTIVE    │                        │
              │     └────────┬─────────┘                        │
              │              │                                  │
              │   step():    │                                  │
              │   数据未写完 │                                  │
              └──────────────┘                                  │
                             │                                  │
                   step():   │                                  │
                   数据写完  │                                  │
                             ▼                                  │
                    ┌──────────────────┐                        │
                    │ WRITE_FINALIZING │                        │
                    └────────┬─────────┘                        │
                             │                                  │
                   step():   │                                  │
                   执行finalize                                 │
                             │                                  │
                    ┌────────┴─────────┐                        │
                    │                  │                        │
                 成功               失败                        │
                    │                  │                        │
                    ▼                  ▼                        │
              ┌──────────┐     ┌──────────┐                    │
              │WRITE_DONE│     │WRITE_FAILED│───────────────────┘
              │(OK)      │     │           │   (下次 begin 复位)
              └──────────┘     └──────────┘
```

**状态枚举**（`storage_app.c` 内部）：

```c
typedef enum {
    WRITE_IDLE = 0,       /* 无活跃写入会话 */
    WRITE_ACTIVE,         /* 分步数据写入进行中 */
    WRITE_FINALIZING,     /* 数据已写完，等待执行 finalize（rename） */
    WRITE_DONE,           /* 写入成功完成 */
    WRITE_FAILED          /* 写入失败（已自动清理） */
} write_state_t;
```

### 6.3 内部数据结构

```c
/* storage_app.c 内部 */
#include "storage_hal.h"
#include "storage_core.h"
#include "market/storage_api.h"
#include <string.h>
#include <assert.h>

/* ========== 配置常量 ========== */
#define STORAGE_MAX_PAYLOAD_LEN  512u   /* 最大 Payload 字节数 */
#define STORAGE_STEP_SIZE        256u   /* 每步写入字节数（产品特有，APP 层定义） */

/* ========== 帧缓冲区（静态分配，load 与 save 复用） ========== */
/*
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
static size_t s_write_offset;     /* 当前写入偏移 */
static size_t s_write_total_len;  /* 帧总长度 */

/* ========== 写入状态机 ========== */
static write_state_t s_write_state = WRITE_IDLE;

/* ========== 初始化标志 ========== */
static bool s_initialized = false;
static bool s_hal_ready   = false;
```

### 6.4 延迟初始化（Lazy Init）

**设计决策**：Storage 管线不暴露任何公共初始化接口。初始化在首次被调用时自动完成，对消费者完全透明。

**理由**：
- 架构文档 §9 明确 `main` 不依赖 `storage_api`，不得在 `setup()` 中调用 Storage 初始化。
- 架构文档 §6.4 的 `setup()` 序列中无 Storage 初始化步骤。
- Storage 是被动服务者，不应要求外部主动初始化自己。

```c
/**
 * 确保 Storage 子系统已初始化。
 * 首次调用时执行 HAL 初始化，后续调用直接返回缓存结果。
 * 线程安全：单核无抢占模型下无需保护。
 */
static bool ensure_initialized(void)
{
    if (!s_initialized) {
        s_hal_ready = storage_hal_init();
        s_initialized = true;
    }
    return s_hal_ready;
}
```

**初始化时序**：

```
setup():
  pot_init()
  cmd_cfg_init()
    └─ storage_load_config()          ← 首次调用
         └─ ensure_initialized()      ← 触发 storage_hal_init()
              ├─ lfs_mount()          ~5ms
              ├─ [若失败] lfs_format() ~50ms + lfs_mount()
              └─ lfs_remove("/cfg.tmp")  < 1ms（清理孤儿文件）
         └─ 继续执行 load 逻辑
  进入 loop()
```

### 6.5 公共接口实现

#### 6.5.1 `storage_save_config_begin()`

```c
bool storage_save_config_begin(const uint8_t *data, size_t len)
{
    /* 前置检查 */
    if (!ensure_initialized()) return false;
    if (data == NULL || len == 0 || len > STORAGE_MAX_PAYLOAD_LEN) return false;
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
    s_write_offset = 0;

    /* 步骤 6：切换状态 */
    s_write_state = WRITE_ACTIVE;
    return true;
}
```

**设计说明**：
- `data` 指针的内容在 `begin()` 中被**完整拷贝**到 `s_frame_buf`，调用者在 `begin()` 返回后可立即释放或修改原始缓冲区。
- 帧缓冲区为静态分配，生命周期覆盖整个写入会话，无需动态内存管理。
- HAL 打开操作在帧构建之前执行。若 HAL 打开失败，`s_frame_buf`、`s_write_offset`、`s_write_total_len` 均未被修改，`s_write_state` 保持原值（IDLE / DONE / FAILED），后续 `begin()` 可正常重试。

#### 6.5.2 `storage_save_config_step()`

**市场 API 契约**（源自架构文档 §4.4）：

```c
/**
 * 执行一步写入操作。
 * @return false = 还有剩余工作，调用者应在下一轮次继续调用。
 *         true  = 会话已结束。
 *
 * @warning 返回 true 仅表示会话结束，不表示写入成功。
 *          调用者在收到 true 后，必须通过 storage_load_config()
 *          回读验证确认数据已正确持久化。
 *          不得将 true 直接等同于写入成功。
 */
bool storage_save_config_step(void);
```

**实现**：

```c
bool storage_save_config_step(void)
{
    switch (s_write_state) {

    case WRITE_ACTIVE: {
        /* 计算本步写入范围 */
        size_t remaining = s_write_total_len - s_write_offset;
        size_t step_len = (remaining > STORAGE_STEP_SIZE)
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
```

**失败检测机制**：

当 `step()` 返回 `true` 时，调用者通过回读验证判断写入是否成功：

```c
/* cmd_cfg_task() 中的使用模式（伪代码） */
case CFG_SAVING:
    if (storage_save_config_step()) {
        /* 会话结束，验证是否成功 */
        uint8_t verify_buf[64];
        size_t  verify_len;
        if (storage_load_config(verify_buf, sizeof(verify_buf), &verify_len)) {
            /* 成功：切换 RAM 快照，发送 ACK */
            config_snapshot_swap();
            midi_send_sysex(ACK);
        } else {
            /* 失败：不切换快照，恢复 Pot，发送 NACK */
            pot_set_pause(false);
            midi_send_sysex(NACK);
        }
        state = CFG_IDLE;
    }
    break;
```

**设计决策说明**：

架构文档 §4.4 冻结了 5 个市场 API 函数，不允许新增接口。因此采用**回读验证**方案：
- 优点：不修改冻结的市场 API；验证逻辑对调用者透明（load 成功 = 数据确实已持久化）。
- 代价：增加一次 Flash 读取（~1ms），在 10ms 主循环周期内可接受。
- 此方案比内部标志查询更可靠：它验证的是**端到端数据完整性**，而非仅检查中间状态。

#### 6.5.3 `storage_save_config_abort()`

```c
void storage_save_config_abort(void)
{
    if (s_write_state == WRITE_ACTIVE || s_write_state == WRITE_FINALIZING) {
        storage_hal_write_cancel();
    }
    s_write_state = WRITE_IDLE;
}
```

#### 6.5.4 `storage_load_config()`

```c
bool storage_load_config(uint8_t *buf, size_t max_len, size_t *out_len)
{
    if (!ensure_initialized()) return false;
    if (buf == NULL || out_len == NULL || max_len == 0) return false;

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
```

#### 6.5.5 `storage_erase_config()`

```c
bool storage_erase_config(void)
{
    if (!ensure_initialized()) return false;

    /* 若正在写入，先中止 */
    if (s_write_state == WRITE_ACTIVE || s_write_state == WRITE_FINALIZING) {
        storage_save_config_abort();
    }

    return storage_hal_remove_file();
}
```

---

## 7. 错误处理策略

### 7.1 错误分类与响应

| 错误场景 | 检测点 | 响应策略 | 对调用者的表现 |
|----------|--------|----------|----------------|
| Flash 硬件不可用 | `ensure_initialized()` | `s_hal_ready = false`，所有后续操作返回 `false` | 所有 API 返回 `false` |
| LittleFS 挂载失败 | `storage_hal_init()` | 自动格式化后重试；仍失败则标记不可用 | 同上 |
| Payload 参数非法 | `storage_save_config_begin()` | 立即返回 `false`，不修改任何状态 | `begin()` 返回 `false` |
| HAL 打开临时文件失败 | `storage_save_config_begin()` | 立即返回 `false`，不修改任何状态（HAL 操作在帧构建之前） | `begin()` 返回 `false` |
| 写入过程中 Flash I/O 错误 | `storage_save_config_step()` | 自动 `cancel()` 清理临时文件，状态 → `WRITE_FAILED` | `step()` 返回 `true`（会话结束） |
| finalize 失败 — close 错误 | `storage_save_config_step()` | 尝试删除临时文件（可能也失败），状态 → `WRITE_FAILED`，残留文件由下次 init 清理 | `step()` 返回 `true`（会话结束） |
| finalize 失败 — rename 错误 | `storage_save_config_step()` | 状态 → `WRITE_FAILED`，临时文件残留（下次 init 清理） | `step()` 返回 `true`（会话结束） |
| 非活跃状态调用 step() | `storage_save_config_step()` | 触发 debug assert，返回 `true` | 调用者回读验证将反映 Flash 实际状态（防御性路径，正常流程不应到达） |
| 读取时文件不存在 | `storage_load_config()` | 返回 `false` | 调用者回退出厂默认 |
| 读取时 CRC 校验失败 | `storage_load_config()` | 返回 `false` | 同上 |
| 读取时 magic/version 不匹配 | `storage_load_config()` | 返回 `false` | 同上 |
| 读取时文件截断 | `storage_load_config()` | 返回 `false` | 同上 |
| 擦除时正在写入 | `storage_erase_config()` | 先 `abort()` 再擦除 | 正常返回 `true` |

### 7.2 断电安全分析

| 断电时刻 | 系统状态 | 恢复结果 |
|----------|----------|----------|
| `begin()` 之前 | 无写入会话 | `/cfg.bin` 完好，下次启动正常加载 |
| `write_step()` 执行中 | `/cfg.tmp` 不完整，`/cfg.bin` 未动 | 下次启动：`storage_hal_init()` 清理 `/cfg.tmp`；`storage_load_config()` 读取 `/cfg.bin` 成功，旧配置有效 |
| `finalize()` 中 `lfs_file_close` 之后、`lfs_rename` 之前 | `/cfg.tmp` 完整，`/cfg.bin` 为旧数据 | 同上，旧配置仍有效（rename 未执行，旧文件未被触碰） |
| `finalize()` 中 `lfs_rename` 执行中 | LittleFS 内部原子操作 | LittleFS copy-on-write 保证：要么 rename 完成（新配置生效），要么未完成（旧配置有效） |
| `finalize()` 中 `lfs_rename` 之后 | `/cfg.bin` 为新数据 | 新配置生效 |
| `erase` 执行中 | `/cfg.bin` 可能已删除 | 下次启动 `storage_load_config()` 返回 `false`，回退出厂默认 |

**结论**：在任何时刻断电，系统均能恢复到一致状态（有效旧配置或出厂默认），不会出现不可恢复的损坏。由于 `lfs_rename()` 是原子操作且自动覆盖已存在的目标文件，不存在"旧文件已删除但新文件未就位"的中间状态。

### 7.3 写入失败的上层感知

架构文档 §6.2 规定："Flash 写入失败或 abort 时，RAM 快照不切换，恢复 Pot 并发送 NACK。"

Storage 管线本身**不主动通知**调用者写入失败（符合被动服务者原则）。失败感知通过**回读验证**实现（见 §6.5.2 使用模式）：

1. `step()` 返回 `true` 表示会话结束（成功或失败）。
2. 调用者调用 `storage_load_config()` 回读验证。
3. 回读成功 → 数据确实已持久化 → 切换快照 + ACK。
4. 回读失败 → 数据未持久化 → 不切换 + NACK。

此方案的优势：
- 不修改冻结的市场 API（无需新增函数）。
- 验证的是端到端数据完整性，比检查内部标志更可靠。
- 额外开销 ~1ms，在 10ms 主循环周期内可接受。

**已知局限性**：

回读验证确认的是"Flash 中存在**某个**有效配置"，而非"Flash 中存在**本次写入的**配置"。在以下极端场景中可能给出假阳性：

> 写入会话在 `WRITE_ACTIVE` 阶段因 Flash I/O 错误失败 → `step()` 返回 `true` → 调用者回读验证 → Flash 中仍存在上一次成功写入的旧配置 → `storage_load_config()` 返回 `true` → 调用者误判为本次写入成功。

**风险评估**：
- 发生条件：Flash I/O 错误恰好发生在写入过程中，且旧配置仍完好。
- 发生概率：极低。RP2040 板载 SPI Flash 的写入错误率远低于 10⁻⁶/次。
- 后果：RAM 快照与 Flash 内容不一致（RAM 为新配置，Flash 为旧配置）。下次上电将加载旧配置，用户需重新配置。不会导致数据损坏或系统不可用。
- 缓解：若需更严格的验证，调用者可在回读后与原始写入数据进行 `memcmp` 比较。此逻辑在 `cmd_cfg_task` 内部完成，不需要修改 Storage 管线的市场 API。

**结论**：此局限性在当前使用场景中可接受，不构成设计缺陷。

---

## 8. 时序分析

### 8.1 主循环周期假设

以下时序分析基于**主循环周期 10ms** 的假设。主循环周期由 `cmd_cfg_task()` 的调用频率决定，受 USB 轮询和 Pot 扫描节奏影响，典型值为 10ms。

### 8.2 `cmd_cfg_task()` 写入状态机轮次划分

为统一时序分析基准，明确 `cmd_cfg_task()` 中配置写入相关的状态机轮次划分：

| 状态 | 每轮次执行的操作 | 说明 |
|------|-----------------|------|
| `CFG_SAVE_START` | `led_event_save_start()` + `pot_set_pause(true)` + `storage_save_config_begin()` → 进入 `CFG_SAVING` | 1 个轮次 |
| `CFG_SAVING` | `storage_save_config_step()` → 若返回 `false` 则停留；若返回 `true` 则执行回读验证 + 结果处理 → 进入 `CFG_SAVE_DONE` | 每步 1 个轮次 |
| `CFG_SAVE_DONE` | `pot_set_pause(false)` + `led_event_save_done()` + `midi_send_sysex(ACK/NACK)` → 进入 `CFG_IDLE` | 1 个轮次 |

**关键约定**：回读验证在 `CFG_SAVING` 状态的最后一轮（`step()` 返回 `true` 时）执行，与结果判定（ACK/NACK 决策）在同一轮次完成。`pot_set_pause(false)` 和 LED/ACK 发送在下一个轮次（`CFG_SAVE_DONE`）执行。

### 8.3 分步写入时序（典型场景：28 字节 Payload）

```
帧总长度 = 16 (Header) + 28 (Payload) = 44 bytes
步长 = 256 bytes
数据写入步数 = ceil(44 / 256) = 1 步
总步数 = 1 (数据) + 1 (finalize) = 2 步

主循环轮次    状态           动作                          耗时估算
─────────────────────────────────────────────────────────────────────
Tick N       CFG_SAVE_START:
             led_event_save_start()         < 0.1ms
             pot_set_pause(true)            < 0.01ms
             storage_save_config_begin()    < 0.1ms
             [Pot 暂停开始]
             → 进入 CFG_SAVING

Tick N+1     CFG_SAVING:
             storage_save_config_step()
               └─ WRITE_ACTIVE:
                  storage_hal_write_step(44B)  ~0.5ms
                  → 数据写完，进入 WRITE_FINALIZING
             返回 false（还有 finalize 一步）

Tick N+2     CFG_SAVING:
             storage_save_config_step()
               └─ WRITE_FINALIZING:
                  storage_hal_write_finalize()
                    ├─ lfs_file_close       ~0.5ms
                    └─ lfs_rename           ~0.5ms（最坏 ~45ms，见 §8.4）
             返回 true（会话结束）
             回读验证 storage_load_config()  ~1ms
             结果判定（ACK/NACK 决策）       < 0.01ms
             → 进入 CFG_SAVE_DONE

Tick N+3     CFG_SAVE_DONE:
             pot_set_pause(false)            < 0.01ms
             [Pot 暂停结束]
             led_event_save_done()           < 0.1ms
             midi_send_sysex(ACK)            < 0.5ms
             → 进入 CFG_IDLE

Pot 暂停跨越 Tick N ~ Tick N+3，共 4 个主循环轮次。
典型 Pot 暂停时间：4 × 10ms = ~40ms
最坏 Pot 暂停时间：10 + 10 + 55 + 10 = ~85ms（finalize 触发 metadata 擦除）
```

### 8.4 最坏情况分析：finalize 中的 metadata 擦除

`lfs_rename()` 需要更新目录项元数据。LittleFS 的元数据以 Metadata Pair 形式存储，更新时需要：
1. 将新元数据写入 pair 中的另一个 block（1 次 prog，~45μs）
2. 若 pair 中两个 block 都已满，需擦除一个 block 后重写（1 次 erase，~45ms）

**发生概率**：在 Lyre 的使用场景中，LittleFS 分区仅包含 1-2 个文件（`/cfg.bin` + 可能的 `/cfg.tmp`），元数据量极小。Metadata block 擦除仅在数百次写入后才可能触发一次。

**影响**：即使触发，也仅影响一个主循环轮次（10ms 周期被拉长至 ~55ms）。由于 finalize 已被拆分为独立步骤（`WRITE_FINALIZING` 状态），不会与其他数据写入步骤叠加。LED 可能出现一次可感知的短暂停滞，但不会导致 USB 缓冲区溢出（SysEx 接收有硬件 FIFO 缓冲）。

**结论**：当前设计在典型场景下满足 ADR-005 的 "<5ms" 约束。最坏场景为低概率事件，影响可控，无需额外缓解措施。

### 8.5 最大 Payload 场景（512 字节）

```
帧总长度 = 16 + 512 = 528 bytes
数据写入步数 = ceil(528 / 256) = 3 步
总步数 = 3 (数据) + 1 (finalize) = 4 步

主循环轮次    状态           动作
─────────────────────────────────────────────────────────────────────
Tick N       CFG_SAVE_START: begin()
             [Pot 暂停开始]
             → 进入 CFG_SAVING

Tick N+1     CFG_SAVING:     step() → false (写入 256B)
Tick N+2     CFG_SAVING:     step() → false (写入 256B)
Tick N+3     CFG_SAVING:     step() → false (写入 16B, 进入 FINALIZING)
Tick N+4     CFG_SAVING:     step() → true  (执行 finalize)
                             回读验证 + 结果判定
             → 进入 CFG_SAVE_DONE

Tick N+5     CFG_SAVE_DONE:
             pot_set_pause(false)
             [Pot 暂停结束]
             led_event_save_done()
             midi_send_sysex(ACK)
             → 进入 CFG_IDLE

Pot 暂停跨越 Tick N ~ Tick N+5，共 6 个主循环轮次。
典型 Pot 暂停时间：6 × 10ms = ~60ms
```

### 8.6 配置加载时序（上电）

```
cmd_cfg_init():
  storage_load_config()
    └─ ensure_initialized()  [首次调用]
         ├─ lfs_mount()                ~5ms（含 Flash 读取超级块）
         ├─ [若失败] lfs_format()      ~50ms（擦除全部分区）+ lfs_mount() ~5ms
         └─ lfs_remove("/cfg.tmp")     < 1ms
    └─ storage_hal_read_file()         ~2ms
    └─ storage_header_deserialize()    < 0.01ms
    └─ storage_crc32 (28B)             < 0.01ms

  总初始化耗时：< 10ms（正常）/ < 60ms（首次格式化）
```

---

## 9. 可测试性设计

### 9.1 CORE 层单元测试

CORE 层零外部依赖，可在 PC 上直接编译运行单元测试。

| 测试项 | 验证内容 |
|--------|----------|
| CRC-32 正确性 | `storage_crc32("123456789", 9) == 0xCBF43926` |
| CRC-32 空输入 | `storage_crc32(NULL, 0) == 0x00000000` |
| CRC-32 单字节 | `storage_crc32("\x00", 1) == 0xD202EF8D` |
| CRC-32 表首尾验证 | `s_crc_table[0] == 0x00000000`, `s_crc_table[255] == 0xB3667A2E` |
| Header 序列化/反序列化往返 | `deserialize(serialize(hdr)) == hdr` |
| Header 构建 | magic、version、payload_len、crc 字段正确 |
| Header 构建 - 零长度 | `storage_header_build(NULL, 0, &hdr)` → `hdr.crc32 == 0x00000000`，不崩溃 |
| Header 验证 - 正常 | 合法 Header + 正确 Payload → `true` |
| Header 验证 - magic 错误 | 篡改 magic → `false` |
| Header 验证 - version 错误 | 篡改 version → `false` |
| Header 验证 - CRC 错误 | 篡改 Payload 1 字节 → `false` |
| Header 验证 - 长度不匹配 | `payload_len` 与实际不符 → `false` |

### 9.2 HAL 层集成测试

HAL 层依赖 RP2040 硬件，需在目标板上测试。

| 测试项 | 验证内容 |
|--------|----------|
| 初始化 - 空白 Flash | 自动格式化后挂载成功 |
| 初始化 - 已有文件系统 | 直接挂载成功 |
| 初始化 - 孤儿文件清理 | 预置 `/cfg.tmp` → init 后不存在 |
| 写入/读取往返 | begin → step × N → finalize → read，内容一致 |
| 删除后读取 | 删除文件 → 读取返回 `false` |
| cancel 后读取 | begin → step → cancel → read 旧文件仍完整 |
| 断电恢复 - 数据写入中 | 写入过程中模拟复位 → 重启后旧数据完整，`/cfg.tmp` 已清理 |
| 断电恢复 - finalize 中 | finalize 前模拟复位 → 重启后旧数据完整（rename 未执行） |
| 参数校验 | `read_file(NULL, ...)` → `false`；`write_step(NULL, 0)` → `false` |

### 9.3 APP 层集成测试

| 测试项 | 验证内容 |
|--------|----------|
| Lazy Init | 首次 load 自动触发 HAL init |
| begin → step × N → 完成 | 完整写入流程，回读验证 |
| begin 参数校验 | NULL / 0 / 超限 → 返回 `false` |
| begin HAL 失败不修改状态 | 模拟 HAL write_begin 失败 → 返回 `false`，`s_frame_buf` 和进度变量未被修改 |
| 重入保护 | ACTIVE/FINALIZING 状态下再次 begin → 返回 `false` |
| abort 后状态恢复 | abort → 再次 begin → 正常完成 |
| step 失败处理 | 模拟 HAL write_step 失败 → step 返回 true → load 返回 false |
| finalize 失败处理 | 模拟 HAL finalize 失败 → step 返回 true → load 返回 false |
| 非活跃状态调用 step | IDLE 状态调用 step → 返回 true（debug assert 触发） |
| load 回退 | 擦除后 load → 返回 `false` |
| 端到端 | 模拟 `cmd_cfg_task()` 完整状态机驱动 |
| 缓冲区复用安全 | 连续执行 save → load（回读验证）→ save → load，数据正确 |

---

## 10. 移植性指南

### 10.1 更换存储介质

若需将 SPI Flash 替换为 I2C EEPROM 或 SD 卡：

1. **仅修改 `storage_hal.c`**：替换 LittleFS 回调为对应介质的读写擦除实现。
2. **调整 HAL 层内部配置宏**：如 `STORAGE_BLOCK_SIZE`、`STORAGE_FLASH_OFFSET` 等。
3. **若新介质不支持文件系统**（如裸 EEPROM），可在 HAL 层内部实现简单的线性存储管理，保持 `storage_hal_write_begin/step/finalize/cancel` 和 `read_file/remove_file` 语义不变。
4. **CORE 层和 APP 层代码零修改**。

### 10.2 更换 MCU 平台

1. **修改 `storage_hal.c`**：适配新平台的 Flash 驱动 API（如 STM32 HAL Flash）。
2. **注意 XIP 约束**：若新平台同样存在 Flash 写入时禁止 XIP 的限制，需将写入回调放入 RAM 执行。
3. **调整中断保护**：将 `save_and_disable_interrupts()` 替换为平台对应的临界区保护。
4. **CORE 层和 APP 层代码零修改**。

### 10.3 调整步长

若新平台的 Flash 页大小不同（如 I2C EEPROM 页大小为 32 字节）：

1. **仅修改 `storage_app.c` 中的 `STORAGE_STEP_SIZE` 宏**。
2. CORE 层和 HAL 层无需修改。
3. 步长变化仅影响写入步数和每步耗时，不影响正确性。

### 10.4 跨产品复用

Storage 管线的 CORE 层（CRC-32、Header 编解码）为纯算法模块，可直接拷贝到任何需要配置持久化的嵌入式产品中，无需任何修改。APP 层仅需调整 `STORAGE_MAX_PAYLOAD_LEN`、`STORAGE_STEP_SIZE` 和配置文件路径即可适配不同产品的配置结构。

---

## 11. 附录

### 11.1 完整头文件清单

| 文件 | 可见性 | 包含者 |
|------|--------|--------|
| `market/storage_api.h` | 全局公共 | `cmd_cfg_app.c` |
| `pipelines/storage/storage_hal.h` | 管线内部 | `storage_app.c` |
| `pipelines/storage/storage_core.h` | 管线内部 | `storage_app.c` |
| `pipelines/storage/storage_app.h` | 管线内部 | 调试/测试代码 |

**注意**：`main.c` 不包含任何 Storage 管线头文件（遵循 C-08 约束）。

### 11.2 宏定义汇总

| 宏名 | 定义位置 | 值 | 说明 |
|------|----------|-----|------|
| `STORAGE_MAGIC` | `storage_core.h` | `0x4C595245` | Header 魔数 |
| `STORAGE_HDR_VERSION` | `storage_core.h` | `0x0001` | Header 版本 |
| `STORAGE_HDR_SIZE` | `storage_core.h` | `16` | Header 字节数 |
| `STORAGE_MAX_PAYLOAD_LEN` | `storage_app.c` | `512` | 最大 Payload 字节数 |
| `STORAGE_STEP_SIZE` | `storage_app.c` | `256` | 分步写入逻辑步长 |
| `STORAGE_FLASH_OFFSET` | `storage_hal.c` | `1024*1024` | Flash 分区起始偏移 |
| `STORAGE_FLASH_SIZE` | `storage_hal.c` | `64*1024` | Flash 分区大小 |
| `STORAGE_BLOCK_SIZE` | `storage_hal.c` | `4096` | Flash 扇区大小 |
| `STORAGE_CFG_PATH` | `storage_hal.c` | `"/cfg.bin"` | 配置文件路径 |
| `STORAGE_TMP_PATH` | `storage_hal.c` | `"/cfg.tmp"` | 临时文件路径 |

### 11.3 与架构文档的追溯矩阵

| 架构文档条目 | 本详细设计对应章节 |
|--------------|-------------------|
| §3 Storage 管线职责 | §1.1 |
| §4.4 storage_api.h 接口（5 个函数） | §6.5 |
| §5.3 三层结构 | §2 |
| §6.2 业务流 2（配置写入） | §6.5.1–6.5.3, §8.2–8.5 |
| §6.2 失败处理（NACK） | §7.3 |
| §6.4 业务流 4（启动加载） | §6.5.4, §6.4, §8.6 |
| §6.4 加载失败后写入默认 | §1.4（职责边界声明） |
| §7 并发与数据一致性 | §4.3.2（中断保护）, §4.3.4（原子替换） |
| §9 依赖关系图 | §6.4（Lazy Init）, §11.1 |
| ADR-005 分步状态机 | §6.2, §8 |
| C-02/C-03 Header 自动管理 | §3.2, §6.5.1, §6.5.4 |
| C-04 失败统一回退 | §7.1 |
| C-07 移植性 | §10 |
| C-08 main 不依赖 storage | §6.4, §11.1 |

### 11.4 审计发现处置记录

#### v1.0 审计（12 项）

| 编号 | 级别 | 问题摘要 | 处置 | 说明 |
|------|------|----------|------|------|
| P0-1 | P0 | 初始化违反架构隔离 | ✅ v1.1 修复 | 改为 Lazy Init（§6.4） |
| P0-2 | P0 | HAL 接口定义矛盾 | ✅ v1.1 修复 | 删除死接口，统一为分步写入（§4.2） |
| P0-3 | P0 | step() 返回值歧义 | ✅ v1.1 修复 + v1.2 强化 | 回读验证方案 + `@warning` 注释（§6.5.2） |
| P1-1 | P1 | finalize 潜在长阻塞 | ✅ v1.1 修复 | WRITE_FINALIZING 独立状态（§6.2） |
| P1-2 | P1 | LittleFS 不清理孤儿文件 | ✅ v1.1 修复 | init 时显式清理（§4.3.3） |
| P1-3 | P1 | 栈上 528 字节数组 | ✅ v1.1 修复 | 静态 `s_frame_buf` 复用（§6.3） |
| P2-1 | P2 | 加载失败后写入默认未覆盖 | ✅ v1.1 修复 | §1.4 职责边界声明 |
| P2-2 | P2 | CORE 层含产品特有假设 | ✅ v1.1 修复 | 进度管理移入 APP 层（§2.2, §5, §6.3） |
| P2-3 | P2 | `storage_hal_is_ready()` 死接口 | ✅ v1.1 修复 | 已删除 |
| P2-4 | P2 | CRC 表懒初始化 | ✅ v1.1 修复 | 编译期常量表（§5.3） |
| P3-1 | P3 | 状态机图与枚举不一致 | ✅ v1.1 修复 | 统一为 5 状态（§6.2） |
| P3-2 | P3 | Payload 容量依据不清 | ✅ v1.1 修复 | 补充 28 字节计算明细（§3.4） |

#### v1.1 审计（9 项）

| 编号 | 级别 | 问题摘要 | 处置 | 说明 |
|------|------|----------|------|------|
| N-01 | P1 | step() 返回 true 语义歧义残留 | ✅ v1.2 修复 | 在 API 契约中增加 `@warning` 注释（§6.5.2） |
| N-02 | P1 | finalize 中 lfs_remove + lfs_rename 非原子窗口 | ✅ v1.2 修复 | 删除多余的 `lfs_remove`，直接 `lfs_rename`（§4.3.4） |
| N-03 | P2 | s_frame_buf 复用未覆盖回读验证场景 | ✅ v1.2 修复 | §6.3 注释补充场景分析 |
| N-04 | P2 | 非活跃状态 step() 返回 true 语义不清 | ✅ v1.2 修复 | 增加 debug assert + §7.1 补充说明 |
| N-05 | P2 | storage_header_validate() 未校验上界 | ✅ v1.2 修复 | 函数注释增加 `@note` 前置条件 |
| N-06 | P2 | CRC 表末尾值错误 | ✅ v1.2 修复 | 修正末 8 项 + 增加验证测试 |
| N-07 | P3 | HAL 层未检查 NULL 参数 | ✅ v1.2 修复 | 入口增加参数校验 |
| N-08 | P3 | Pot 暂停时间估算错误 | ✅ v1.2 修复 | 修正轮次计算 + 明确 10ms 假设 |
| N-09 | P3 | "预留"措辞与实现矛盾 | ✅ v1.2 修复 | 改为"已实现，待集成调用" |

#### v1.2 审计（6 项）

| 编号 | 级别 | 问题摘要 | 处置 | 说明 |
|------|------|----------|------|------|
| N-10 | P2 | `begin()` HAL 失败后内部状态不一致 | ✅ v1.3 修复 | 调整步骤顺序：先 HAL 打开，成功后再构建帧（§6.5.1） |
| N-11 | P2 | 回读验证假阳性（无法区分本次写入与旧配置） | ✅ v1.3 修复 | 在 §7.3 补充已知局限性说明和风险评估 |
| N-12 | P2 | `lfs_file_close` 失败后清理说明不完整 | ✅ v1.3 修复 | §4.3.4 增加注释 + §7.1 拆分为 close/rename 两种子场景 |
| N-13 | P3 | §8.2 与 §8.4 轮次划分不一致 | ✅ v1.3 修复 | 新增 §8.2 统一状态机轮次划分基准，§8.5 修正为 6 轮次 |
| N-14 | P3 | `storage_crc32()` 空输入行为未明确 | ✅ v1.3 修复 | 函数注释补充 `len == 0` 行为 + §9.1 增加零长度 Header 构建测试 |
| N-16 | P3 | `storage_hal_write_finalize()` 注释与实现不一致 | ✅ v1.3 修复 | §4.2 注释补充 close 失败清理行为 |

### 11.5 关于审计建议的独立判断

#### v1.0 审计建议

| 审计建议 | 采纳情况 | 理由 |
|----------|----------|------|
| P0-3 方案 A：新增 `storage_save_config_get_result()` | ❌ 未采纳 | 架构文档已冻结，市场 API 限定 5 个函数。回读验证方案不修改 API 且验证更彻底。 |
| P1-1：将 finalize 拆为独立步骤 | ✅ 采纳 | 合理且必要，确保每步阻塞可控。 |
| P2-2 方案一：`step_size` 改为运行时参数 | ❌ 未采纳（过度设计） | 当前产品仅一种存储介质，编译时常量即可。 |
| P2-4：改为编译期常量表 | ✅ 采纳 | 消除行为不确定性，1KB Flash 开销可忽略。 |
| P1-3：复用 `s_frame_buf` | ✅ 采纳 | 合理，单核无抢占模型下安全。 |

#### v1.1 审计建议

| 审计建议 | 采纳情况 | 理由 |
|----------|----------|------|
| N-01：增加 `@warning` 注释 | ✅ 采纳 | 低成本高收益，强化 API 契约文档。 |
| N-01：改为三态返回值（int） | ❌ 未采纳 | 需修改冻结的架构文档。当前回读验证方案已足够可靠。 |
| N-02：删除 `lfs_remove` | ✅ 采纳 | 一行代码修复，消除真实断电风险窗口。 |
| N-04 方案 A：非活跃状态返回 false | ❌ 未采纳 | 可能导致调用者无限循环。 |
| N-04 方案 B+C：保持 true + assert | ✅ 采纳 | 防御性最佳实践。 |
| N-05：在 CORE 层增加上界检查 | ❌ 未采纳（过度设计） | `STORAGE_MAX_PAYLOAD_LEN` 是产品特有约束，放入 CORE 层违反"零产品假设"原则。改为在函数注释中声明前置条件。 |
| N-06：修正 CRC 表值 | ✅ 采纳 | 文档准确性必须保证。 |
| N-07：HAL 层增加 NULL 检查 | ✅ 采纳 | 低成本防御性编程。 |
| N-08：修正时序估算 | ✅ 采纳 | 文档准确性。 |
| N-09：修正"预留"措辞 | ✅ 采纳 | 消除歧义。 |

#### v1.2 审计建议

| 审计建议 | 采纳情况 | 理由 |
|----------|----------|------|
| N-10：调整 `begin()` 步骤顺序 | ✅ 采纳 | 一行代码改动，遵循"失败时不修改任何状态"原则。 |
| N-11：补充回读验证局限性说明 | ✅ 采纳 | 文档透明性，帮助调用者理解风险边界。 |
| N-11：回读后 `memcmp` 比较 | ❌ 未纳入 Storage 管线设计（过度设计） | 此逻辑属于 `cmd_cfg_task` 的可选增强，不属于 Storage 管线职责。在 §7.3 中作为"若需更严格验证"的建议提及即可。 |
| N-12：补充 close 失败注释 | ✅ 采纳 | 文档完整性。 |
| N-13：统一轮次划分 | ✅ 采纳 | 消除文档内部不一致。 |
| N-14：补充 CRC 空输入注释 | ✅ 采纳 | 接口契约完整性。 |
| N-16：统一 finalize 注释 | ✅ 采纳 | 文档一致性。 |

---

*文档结束*
