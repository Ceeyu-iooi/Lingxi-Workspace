(() => {
  let taskId=new URLSearchParams(location.hash.slice(1)).get('lingxi-authorization');
  chrome.runtime.sendMessage({type:'resume'}).then(value=>{if(!value?.taskId)return;taskId=value.taskId;window.postMessage({source:'lingxi-ds-start',taskId},location.origin);}).catch(()=>{});
  const listener=event=>{if(event.source!==window||event.origin!==location.origin||event.data?.source!=='lingxi-ds-auth'||event.data.taskId!==taskId)return;chrome.runtime.sendMessage({type:'credential',taskId,credential:event.data.credential}).finally(()=>{window.removeEventListener('message',listener);window.postMessage({source:'lingxi-ds-stop',taskId},location.origin);});};
  window.addEventListener('message',listener);setTimeout(()=>window.removeEventListener('message',listener),180000);
})();
