# 悬浮窗开源参考与取舍

本页记录2026-10-16本轮读取的开源交互及界面源码。产品当前设计以根目录design.md为准；不复制外部项目源码、视觉资产或引入其依赖。许可证原文见各仓库，不能以“开源”替代授权核对。

| 项目与实际读取文件 | 可参考之处 | 本项目取舍 |
|---|---|---|
| [TrafficMonitor](https://github.com/zhongyang219/TrafficMonitor) · [TrafficMonitorDlg.cpp](https://github.com/zhongyang219/TrafficMonitor/blob/master/TrafficMonitor/TrafficMonitorDlg.cpp) | 小面积监测、按皮肤布局选择内容、正文鼠标操作与右键菜单 | 复用紧凑数据表面及低频菜单的交互思路；保留现有用量来源和口径，不复制其绘制或系统监测代码 |
| [Guage](https://github.com/evoziosk/guage) · [src/ui/widget.py](https://github.com/evoziosk/guage/blob/main/src/ui/widget.py) | 无框置顶、双环/条形/mini视图、正文拖动、按模式设置尺寸 | 以额度为视觉主体，移除悬浮窗Logo标题条；采用既有React组件及缓动，不复制Qt绘制代码或常驻每秒整窗刷新 |
| [OpenTokenMonitor](https://github.com/Hitheshkaranth/OpenTokenMonitor) · [WidgetMode.tsx](https://github.com/Hitheshkaranth/OpenTokenMonitor/blob/main/src/components/layout/WidgetMode.tsx) / [useWidgetResize.ts](https://github.com/Hitheshkaranth/OpenTokenMonitor/blob/main/src/hooks/useWidgetResize.ts) | 组件化紧凑监测、独立widget视图、窗口尺寸适配与清理 | 分离悬浮内容与按需加载设置，保留自己的Electron安全桥和生命周期；不引入其采集服务、业务状态或Tauri插件 |

贴边问题使用本项目自身的原生区域裁剪和光标命中实现，不将网页hover样例直接当作Windows悬浮窗方案。尺寸稳定后以transform呈现展开/收起，短时同步原生绘制及点击区域；64ms光标核对仅在吸附且未全屏隐藏时启用，自由、拖动、禁用及退出时停止。依据[Electron BrowserWindow.setShape](https://www.electronjs.org/docs/latest/api/browser-window#winsetshaperects-windows-linux-experimental)的命中语义，收缩后的透明区域不拦截其他窗口。

0.1.12仅进行源码与隔离协议验证：真实OS鼠标碰边、原生合成器观感和多屏/DPI未执行。模拟光标坐标、模拟菜单/全屏协议、Chromium合成数据截图与实际原生输入验收分别记录，不互相替代。


## 本地Token Manager参考（0.1.13）

只读检查用户指定程序的嵌入前端，未执行目标或读取其账户；内部证据报告绑定EXE及恢复资产摘要。它使用Tauri与Vue，展开为单列数据与Agent条目，额度采用细条；边缘轨使用小环。参考其数据行、次级操作及连续几何过渡，不复制代码、商标、资源或采集逻辑。

实际CSS最终覆盖为纯色并禁用背景模糊，不能称为原生毛玻璃。虽有hover peek辅助函数，当前组件未触发该事件，因此不将其作为已验证交互。其较宽轨道、Logo和状态岛不适合本项目默认双额度8 DIP边签，保留自己的信息容量与工作台主题。曲线cubic-bezier(.22,1,.36,1)与本项目已有曲线一致，继续使用260/200ms时长，不加入第二套动效库。

本项目新增透明原生宿主、DWM材质按状态撤回、内容提交后呈现。Electron官方说明透明窗口必须在构造时开启transparent，且系统原生缩放边框与透明兼容受限；详细面板改用可见尺寸柄及方向键。依据[透明窗口文档](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles)与[原生材质文档](https://www.electronjs.org/docs/latest/api/base-window#winsetbackgroundmaterialmaterial-windows)。源码/隔离协议与真实Windows合成器显示分别验收，不再将setShape成功当作背景已消失的证据。
