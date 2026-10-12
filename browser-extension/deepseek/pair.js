if(location.pathname==='/bridge/deepseek'){
  let pairing;try{pairing=JSON.parse(decodeURIComponent(location.hash.slice(1)));}catch{}
  if(pairing)chrome.runtime.sendMessage({type:'pair',pairing}).then(value=>{document.querySelector('[data-bridge-status]').textContent=value?.error||'授权桥已连接，请在官方页面完成登录。';}).catch(()=>{});
}
