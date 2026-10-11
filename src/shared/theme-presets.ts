export type Palette={sidebar:string;accent:string};
export const defaultDarkPalette:Palette={sidebar:'#10191f',accent:'#6b9cff'};
export const themePresets=[
 {id:'mist',name:'雾蓝工作室',about:'雾蓝侧栏与清楚的蓝色强调。',light:{sidebar:'#edf6f8',accent:'#3976f6'}},
 {id:'linen',name:'亚麻书房',about:'柔和的亚麻色侧栏与暖色强调。',light:{sidebar:'#f1ece3',accent:'#956445'}},
 {id:'jade',name:'青玉庭院',about:'浅青玉侧栏与安静的绿色强调。',light:{sidebar:'#e8f1eb',accent:'#397666'}},
 {id:'nocturne',name:'夜航墨色',about:'沉静的蓝灰侧栏与蓝色强调。',light:{sidebar:'#e8edf4',accent:'#4c6d98'}},
 {id:'wisteria',name:'月白紫藤',about:'轻浅的紫灰侧栏与紫色强调。',light:{sidebar:'#f0ebf5',accent:'#8157ad'}},
 {id:'silver',name:'银灰工坊',about:'克制的银灰侧栏与青灰色强调。',light:{sidebar:'#edf0f3',accent:'#4d7183'}},
] as const;
export const presetPalette=(id:string,mode:string):Palette=>{const p=themePresets.find(p=>p.id===id)||themePresets[0];return mode==='dark'?defaultDarkPalette:p.light;};
