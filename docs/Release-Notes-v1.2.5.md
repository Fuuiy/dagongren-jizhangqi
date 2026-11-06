# 打工人记账器 v1.2.5

## 去掉 workbuddy 标识

Windows 通知气泡的标题原本显示 `com.workbuddy.dagongren.jizhangqi`，改为：

```
com.fuuiy.dagongren.jizhangqi
```

两处必须一致（否则系统会回退显示旧标识）：

- `electron-builder.yml` 的 `appId`
- `main.js` 的 `app.setAppUserModelId()`

同时 exe 属性里的版权署名改为 **Copyright © 2026 Fuuiy**。

## ⚠️ 装之前先卸载旧版

`appId` 变了，Windows / NSIS 会把新版当成另一个应用，**不会覆盖旧版**：

1. 先在「设置 → 应用」卸载旧的「打工人记账器」
2. 再装这个 v1.2.5

数据不受影响（在 `%APPDATA%\打工人记账器`，由 productName 决定，没变）。

## 验证

- 源码里 `workbuddy` 出现 **0 次**
- 打包后 `app.asar` 与安装包 exe 里也都是 **0 次**
- exe 属性：CompanyName=Fuuiy、LegalCopyright=Copyright © 2026 Fuuiy
- 打包冒烟 11/11（连跑 2 轮）

## 顺手

打包冒烟的「打卡 3h」和「小窗」两条偶发误判改成了轮询判断（金额刷新/窗口 resize 都是异步的），
连跑多轮稳定 11/11。
