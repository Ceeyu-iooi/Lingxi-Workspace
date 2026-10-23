// Desktop settings are loaded only when their page is opened.
const host = window as unknown as {mountTaskbarSettings:(root:HTMLElement)=>Promise<void>};
host.mountTaskbarSettings = async root => {
  root.textContent="正在读取插件设置…";
  try {
    const {mountTaskbarSettings}=await import("./taskbar-settings");
    if(root.isConnected)await mountTaskbarSettings(root);
  }catch(error){if(root.isConnected){root.textContent="插件设置读取失败："+(error as Error).message;root.setAttribute("role","alert");}}
};
