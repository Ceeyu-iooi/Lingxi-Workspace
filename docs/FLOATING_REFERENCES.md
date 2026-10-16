# 悬浮窗开源参考与取舍

本页记录2026-10-16本轮读取的开源交互及界面源码。产品当前设计以根目录design.md为准；不复制外部项目源码、视觉资产或引入其依赖。许可证原文见各仓库，不能以“开源”替代授权核对。

| 项目与实际读取文件 | 可参考之处 | 本项目取舍 |
|---|---|---|
| [TrafficMonitor](https://github.com/zhongyang219/TrafficMonitor) · [TrafficMonitorDlg.cpp](https://github.com/zhongyang219/TrafficMonitor/blob/master/TrafficMonitor/TrafficMonitorDlg.cpp) | 小面积监测、按皮肤布局选择内容、正文鼠标操作与右键菜单 | 复用紧凑数据表面及低频菜单的交互思路；保留现有用量来源和口径，不复制其绘制或系统监测代码 |
| [Guage](https://github.com/evoziosk/guage) · [src/ui/widget.py](https://github.com/evoziosk/guage/blob/main/src/ui/widget.py) | 无框置顶、双环/条形/mini视图、正文拖动、按模式设置尺寸 | 以额度为视觉主体，移除悬浮窗Logo标题条；采用既有React组件及缓动，不复制Qt绘制代码或常驻每秒整窗刷新 |
| [OpenTokenMonitor](https://github.com/Hitheshkaranth/OpenTokenMonitor) · [WidgetMode.tsx](https://github.com/Hitheshkaranth/OpenTokenMonitor/blob/main/src/components/layout/WidgetMode.tsx) / [useWidgetResize.ts](https://github.com/Hitheshkaranth/OpenTokenMonitor/blob/main/src/hooks/useWidgetResize.ts) | 组件化紧凑监测、独立widget视图、窗口尺寸适配与清理 | 分离悬浮内容与按需加载设置，保留自己的Electron安全桥和生命周期；不引入其采集服务、业务状态或Tauri插件 |

贴边问题使用本项目自身的原生区域裁剪和光标命中实现，不将网页hover样例直接当作Windows悬浮窗方案。尺寸稳定后以transform呈现展开/收起，短时同步原生绘制及点击区域；64ms光标核对仅在吸附且未全屏隐藏时启用，自由、拖动、禁用及退出时停止。依据[Electron BrowserWindow.setShape](https://www.electronjs.org/docs/latest/api/browser-window#winsetshaperects-windows-linux-experimental)的命中语义，收缩后的透明区域不拦截其他窗口。

本轮只进行源码与隔离协议验证：真实OS鼠标碰边、原生合成器观感和多屏/DPI未执行。模拟光标坐标、模拟菜单/全屏协议、Chromium合成数据截图与实际原生输入验收分别记录，不互相替代。
