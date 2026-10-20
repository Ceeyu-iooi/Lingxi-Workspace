/** Expand families into concrete candidate IDs; never send a pseudo-model to the API. */
export function modelFamilies(models:string[]){
 const rules:[string,RegExp][]=[['OpenAI',/(?:^|[/:])(?:gpt(?:[-_.\s]|\d|$)|o[1-9](?:[-_.\s]|$)|chatgpt)/i],['DeepSeek',/(?:^|[/:])deepseek(?:[-_.\s]|$)/i],['GLM',/(?:^|[/:])(?:glm|chatglm)(?:[-_.\s]|\d|$)/i]];
 return rules.map(([label,pattern])=>({label,models:models.filter(m=>pattern.test(m))})).filter(group=>group.models.length>0);
}
