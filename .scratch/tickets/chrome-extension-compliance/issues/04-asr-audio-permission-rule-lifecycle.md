# 04: asr-audio-permission-rule-lifecycle

**What to build:** 把 ASR 音频请求的域名、动态 DNR 规则、Service Worker 重启恢复和下载/内存资源边界收成一个可验证的生命周期，不依赖后台模块变量。

**Blocked by:** #03 `offscreen-runtime-bridge`

**Status:** ready-for-agent

- [ ] 基于真实 ASR 音频请求确认实际域名，并为无字幕 ASR 流程声明最窄的必要 host 权限，不以宽泛的 `<all_urls>` 代替
- [ ] Referer/Origin DNR 规则在实际 ASR 请求上生效，且目标 host、来源页面和规则作用范围在代码与文档中一致
- [ ] 规则配置持久化到 Service Worker 可恢复的存储；重启后按需重建，并避免重复 ID、旧规则泄漏和并发创建冲突
- [ ] 安装、更新、启动、正常完成、异常取消和后台终止路径都能清理或回收不再使用的动态规则
- [ ] ASR 流程对音频累计下载量、内存占用、待处理音频分片和并发转换设定并执行明确上限，超限时停止新增工作并返回可读错误
- [ ] 新增或更新的测试覆盖实际域名、DNR 规则重建、重复启动、异常清理、累计下载量和内存上限
- [ ] `npm run build`、`npm run typecheck` 与 `npm test` 通过
