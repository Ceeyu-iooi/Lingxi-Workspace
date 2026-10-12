// storage.session is memory-only and survives service-worker suspension, not browser restart.
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  const run=async()=>{
    if(message.type==='pair'){
      const p=message.pairing,u=new URL(sender.url||'');
      if(u.origin!==p.origin||u.hostname!=='127.0.0.1'||u.pathname!=='/bridge/deepseek'||!/^[a-f0-9-]{36}$/.test(p.id)||!/^[a-f0-9]{64}$/.test(p.pairToken)||p.expiresAt<Date.now()||p.expiresAt>Date.now()+181000)throw Error('配对任务不正确');
      const response=await fetch(p.origin+'/bridge/deepseek/handshake',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:p.id,pairToken:p.pairToken})});if(!response.ok)throw Error('配对任务已失效，请重新获取');
      await chrome.storage.session.set({pairing:p});chrome.alarms.create('pair-expiry',{when:p.expiresAt});const url='https://platform.deepseek.com/usage#lingxi-authorization='+p.id;
      const tabs=await chrome.tabs.query({url:'https://platform.deepseek.com/*'});const tab=tabs.length?await chrome.tabs.update(tabs[0].id,{url,active:true}):await chrome.tabs.create({url});
      const current=(await chrome.storage.session.get('pairing')).pairing;if(current?.id===p.id)await chrome.storage.session.set({pairing:{...p,tabId:tab.id}});if(tabs.length&&tabs[0].url?.split('#')[0]==='https://platform.deepseek.com/usage')await chrome.tabs.reload(tab.id);return {ok:true};
    }
    if(message.type==='resume'){
      const {pairing:p}=await chrome.storage.session.get('pairing');
      if(!p||p.tabId!==sender.tab?.id||p.expiresAt<Date.now()||new URL(sender.url||'').origin!=='https://platform.deepseek.com')return {};
      const response=await fetch(p.origin+'/bridge/deepseek/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:p.id,pairToken:p.pairToken})});
      if(!response.ok){await chrome.storage.session.remove('pairing');return {};}
      return {taskId:p.id};
    }
    if(message.type==='credential'){
      const {pairing:p}=await chrome.storage.session.get('pairing');
      if(!p||p.id!==message.taskId||(p.tabId!=null&&p.tabId!==sender.tab?.id)||p.expiresAt<Date.now()||new URL(sender.url||'').origin!=='https://platform.deepseek.com')throw Error('授权任务不匹配');
      try{const response=await fetch(p.origin+'/bridge/deepseek/receive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:p.id,pairToken:p.pairToken,credential:message.credential})});if(!response.ok)throw Error('平台账户与 Key 不匹配或授权已失效，请重新获取');return {ok:true};}finally{await chrome.storage.session.remove('pairing');chrome.alarms.clear('pair-expiry');}
    }
  };run().then(respond,error=>respond({error:error.message}));return true;
});

chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='pair-expiry')void chrome.storage.session.remove('pairing');});
