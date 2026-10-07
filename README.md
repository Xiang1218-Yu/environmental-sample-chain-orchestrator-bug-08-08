# Environmental Sample Chain Orchestrator

一个从 0-1 构建的环境样本链路编排项目基线，用来管理采样、容器封签、跨机构交接、实验室接收、分装、实验批次、仪器结果修订、质量复核和证据包导出。

## 当前实现

- `src/domain/types.ts`：领域对象、状态和同步模型
- `src/domain/time.ts`：时间模型（瞬间规范化、本地业务日期、时钟偏差容忍）
- `src/store/store.ts`：内存 Store、全局 ID、审计、Outbox 和事务快照回滚
- `src/services/sampling-service.ts`：采样记录与封存容器
- `src/services/custody-service.ts`：交出、接收、封签和温度轨迹
- `src/services/receiving-service.ts`：实验室接收、接受/隔离/拒收
- `src/services/aliquot-service.ts`：批量分装、单位换算、容量扣减和幂等操作
- `src/services/batch-service.ts`：实验批次成员、协议冻结和运行生命周期
- `src/services/result-service.ts`：仪器运行、外部运行号幂等和结果 revision
- `src/services/quality-service.ts`：质量结论、质控门槛和批次批准
- `src/services/evidence-service.ts`：一致性证据包、清单哈希和冻结
- `src/services/sync-service.ts`：离线 Envelope、客户端序列、payload 冲突和重放
- `src/demo/smoke.ts`：一条可运行的端到端样例

## 时间与版本模型

系统严格区分四个概念，任何入口（同步上传、直接调用）都遵循同一套规则：

- **事件发生时间**：客户端/仪器上的真实发生时刻。入口统一用 `normalizeInstant` 规范化
  为 UTC 瞬间（ISO 8601、毫秒、`Z`），不保存本地墙钟文本；没有显式偏移量的时间戳会被拒绝。
- **接收时间**：服务端处理记录的时刻（`Store.now()`），仅用于审计，绝不参与业务排序。
- **本地业务日期**：由 `businessDateOf(instant, ianaTimeZone)` 按需从 UTC 瞬间派生，
  使用 IANA 时区库处理夏令时，不使用固定偏移量。
- **结果修订号**：仪器/LIMS 分配的业务版本号，是结果修订之间唯一的排序键。
  修订号更高者生效（哪怕它的发生时间更早、到达更晚）；修订号更低者记为
  `result.revision_stale` 审计并返回当前生效版本；同号同内容幂等，同号不同内容报冲突。

交接链按 `transferSequence` 排序，同步重放按 `clientSequence` 判定 STALE，
两者都不依赖设备时钟；交接确认允许 ±5 分钟的设备时钟偏差。
保存期限（`maxTransitHours`）在 UTC 瞬间之间比较，期限临界点本身视为仍在期限内。
证据包中所有时间保持 UTC 瞬间，本地业务日期按证据包声明的显示时区派生。

## 运行

```bash
npm install
npm run build
npm run smoke
npm test
```

当前源码是**干净基线**，没有为了出题主动埋入 Bug。后续应先在这份基线上补充测试和复现证据，再从真实缺陷中生成 Bug 题目。

时间与版本判断的修复已落地：`test/time-utils.test.mjs` 覆盖瞬间规范化、时区午夜与夏令时；
`test/workflow.test.mjs` 覆盖跨时区上传、设备时钟偏差、保存期限临界点、不同到达顺序下的
结果修订号裁决，以及证据包显示时间。
