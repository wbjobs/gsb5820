# 加密同步任务看板（无服务器）

纯前端多标签页实时协作看板：任务拖拽排序、跨列移动、编辑、删除、截止时间；
所有数据经主密码派生密钥加密后存储，离线可用、恢复自动合并。

## 运行

```bash
python3 -m http.server 8080   # 或任意静态服务器（module worker 需要 http(s) 源）
# 打开 http://localhost:8080 ，首次设置主密码，然后多开 4 个标签页即可协作
```

## 测试

```bash
node test/crdt.test.mjs          # CRDT 单元/收敛性测试（排序键、并发、冲突、幂等）
node test/integration.test.mjs   # 集成测试：真实 worker.js × 4 实例 + 乱序信道 + 共享 IDB
```

## 架构

| 层 | 文件 | 职责 |
| --- | --- | --- |
| UI（主线程） | `js/main.js` | 渲染、Pointer Events 拖拽、内联编辑；不碰数据逻辑 |
| 同步后端（Worker） | `js/worker.js` | 加解密、IndexedDB、BroadcastChannel、反熵、乱序缓冲 |
| CRDT 核心 | `js/crdt.js` | 分数索引排序键 + LWW 寄存器 + op 模型（纯函数，可测） |

### 数据与一致性模型

- 每个变更产生一个 op（`add/set/move/del`），携带：
  - `l`：Lamport 时钟，用于 LWW（Last-Writer-Win）字段比较；
  - `seq`：本标签页连续序号，用于缺口检测与向量时钟（两者不可混用）。
- 任务字段（标题/截止时间/位置/删除墓碑）均为 LWW 寄存器，按 `(l, tabId)` 决胜，
  全部 op 满足交换、结合、幂等 → 任意乱序/重复/离线合并后收敛。
- 排序用分数索引键（`keyBetween`），并发同位插入产生相同键时按任务 id 确定性决胜。
- 冲突语义：删除 vs 编辑/移动 → 时钟大者胜，四方结果一致；移动 vs 移动 → LWW，任务只出现一次。

### 同步协议（BroadcastChannel）

- `op`：实时广播单个加密 op（实测延迟 < 200ms）。
- `hello/have`：解锁时与每 4s 心跳广播向量时钟；收到后双向补齐
  （把对方缺的发过去，同时 `need` 请求自己缺的）。
- `need/ops`：按 seq 缺口补发批量加密 op；乱序 op 先入缓冲，缺口填上后连续应用。
- 离线：开启“模拟离线”或标签页关闭期间，op 全部落 IndexedDB；
  恢复后通过 hello/have 反熵自动合并。

### 加密（Web Crypto，全部在 Worker 内）

- PBKDF2-SHA256（25 万次迭代）从主密码派生 AES-256-GCM 密钥，密钥不出 Worker。
- 每个 op 独立 IV 加密后广播并存入 IndexedDB；`meta` 仅存盐与验证令牌。
- 解锁时解密验证令牌校验密码，错误即提示“主密码错误”；
  收到无法解密的同步消息（其他标签页密码不同）会在顶栏警告。

## 验收标准对照

- 4 标签页并发编辑一致 → `test/integration.test.mjs` B 组（12 轮×4 页并发+乱序）
- 离线恢复合并 → 集成测试 C 组
- 加密存储刷新可解 → 集成测试 D 组（密文检查 + 重解锁恢复）
- 密钥错误提示 → 集成测试 A 组（unlock-fail）
- 拖拽/删除冲突 → `test/crdt.test.mjs` 4/5/6 组
- 消息乱序不丢 → 集成测试使用 0~40ms 随机延迟信道 + CRDT 测试乱序投递
- 同步延迟 < 200ms → 集成测试实测（本机约 40~60ms）
- 主线程不卡 → 加密/CRDT/持久化全在 Worker；主线程仅渲染，状态推送按帧合并
