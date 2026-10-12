(() => {
  let active=false;
  function install(taskId){
  if(active||!taskId||!/^[a-f0-9-]{36}$/.test(taskId))return;active=true;
  const originalFetch=window.fetch,originalOpen=XMLHttpRequest.prototype.open,originalHeader=XMLHttpRequest.prototype.setRequestHeader;
  const requests=new WeakMap();let done=false;
  const valid=url=>{try{const u=new URL(url,location.href);return u.origin===location.origin&&u.pathname.startsWith('/api/v0/');}catch{return false;}};
  const stop=()=>{if(done)return;done=true;active=false;window.fetch=originalFetch;XMLHttpRequest.prototype.open=originalOpen;XMLHttpRequest.prototype.setRequestHeader=originalHeader;clearTimeout(timeout);window.removeEventListener('message',onMessage);};
  const accept=value=>{if(done||typeof value!=='string'||value.length>4096||!/^Bearer\s+\S+$/i.test(value))return;window.postMessage({source:'lingxi-ds-auth',taskId,credential:value.replace(/^Bearer\s+/i,'')},location.origin);stop();};
  window.fetch=function(input,init){if(!done&&valid(input instanceof Request?input.url:String(input))){const headers=new Headers(init?.headers||(input instanceof Request?input.headers:undefined));accept(headers.get('authorization'));}return originalFetch.apply(this,arguments);};
  XMLHttpRequest.prototype.open=function(method,url,...rest){requests.set(this,valid(String(url)));return originalOpen.call(this,method,url,...rest);};
  XMLHttpRequest.prototype.setRequestHeader=function(name,value){if(requests.get(this)&&name.toLowerCase()==='authorization')accept(value);return originalHeader.call(this,name,value);};
  const onMessage=event=>{if(event.source===window&&event.origin===location.origin&&event.data?.source==='lingxi-ds-stop'&&event.data.taskId===taskId)stop();};window.addEventListener('message',onMessage);
  const timeout=setTimeout(stop,180000);
  }
  window.addEventListener('message',event=>{if(event.source===window&&event.origin===location.origin&&event.data?.source==='lingxi-ds-start')install(event.data.taskId);});
  install(new URLSearchParams(location.hash.slice(1)).get('lingxi-authorization'));
})();
