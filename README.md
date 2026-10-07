# Environmental Sample Chain Orchestrator

一个从 0-1 构建的环境样本链路编排项目基线，用来管理采样、容器封签、跨机构交接、实验室接收、分装、实验批次、仪器结果修订、质量复核和证据包导出。

## 当前实现

- `src/domain/types.ts`：领域对象、状态和同步模型
- `src/domain/time.ts`：时间模型——事件发生时间（UTC 瞬时）、接收时间（服务端）、本地业务日期、结果修订号
- `src/store/store.ts`：内存 Store、全局 ID、审计、Outbox 和事务快照回滚
- `src/services/sampling-service.ts`：采样记录与封存容器
- `src/services/custody-service.ts`：交出、接收、封签和温度轨迹
- `src/services/receiving-service.ts`：实验室接收、接受/隔离/拒收、保存期限和时钟偏差校验
- `src/services/aliquot-service.ts`：批量分装、单位换算、容量扣减和幂等操作
- `src/services/batch-service.ts`：实验批次成员、协议冻结和运行生命周期
- `src/services/result-service.ts`：仪器运行、外部运行号幂等和结果 revision
- `src/services/quality-service.ts`：质量结论、质控门槛和批次批准
- `src/services/evidence-service.ts`：一致性证据包、清单哈希和冻结
- `src/services/sync-service.ts`：离线 Envelope、客户端序列、payload 冲突和重放
- `src/demo/smoke.ts`：一条可运行的端到端样例

## 时间模型

- **事件发生时间**：客户端上报、必须带显式时区偏移（`Z` 或 `±HH:MM`），入库统一规范化为 UTC 瞬时，排序与期限判断只使用瞬时。
- **接收时间**：服务端入库时间（`Store.now()`），与客户端时钟无关，单独字段保存。
- **本地业务日期**：按上报方偏移计算的 `YYYY-MM-DD`，与 UTC 日期可能不同，显式存储而不是截断字符串。
- **结果修订号**：仪器/LIMS 给出的业务版本号，决定 CURRENT 归属；迟到但修订号更高的结果会取代当前版本，迟到且更低的结果保留为 SUPERSEDED 仅供审计，与到达顺序无关。

## 运行

```bash
npm install
npm run build
npm run smoke
npm test
```

当前源码是**干净基线**，没有为了出题主动埋入 Bug。后续应先在这份基线上补充测试和复现证据，再从真实缺陷中生成 Bug 题目。
