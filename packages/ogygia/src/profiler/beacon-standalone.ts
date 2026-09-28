/**
 * THE BEACON FOR A PAGE WITHOUT THE OGYGIA RUNTIME — a Kit-hydrated (`csr = true`) page, or any
 * page with no island. The runtime's beacon (runtime/beacon.ts) lives in the runtime, so without
 * this such a page would never report its vitals, long tasks or CPU — and the page score would
 * measure it on less than an islands page (the unfairness the score rework removed).
 *
 * Inline, dependency-free JS the profiler adds for ITS OWN user only (next to the beacon meta tag;
 * never a visitor). It steps aside at once when the ogygia runtime's script is already in the head
 * (the usual order), else watches and checks again at DOMContentLoaded. It must never hold the JS
 * sampler the runtime's beacon needs: the browser runs one at a time. Same payloads as the runtime's:
 * `{page, vitals}`, `{page, visit}` (no islands), `{page, cpu}`. No regex.
 */
export const BEACON_STANDALONE_JS = `(()=>{
if(window.__og_beacon_standalone)return;window.__og_beacon_standalone=1;
var meta=document.querySelector('meta[name="ogygia-profiler-beacon"]');var url=meta&&meta.getAttribute('content');if(!url||typeof PerformanceObserver==='undefined')return;
if(document.querySelector('script[data-ogygia-runtime]'))return;
var r2=function(n){return Math.round(n*100)/100};var rs=0,v={},paints={},shifts=[],longtasks=[],obs=[],off=false,cls=0,sent=false,prof=null,seen=[];
function watch(type,cb){try{var po=new PerformanceObserver(function(l){if(!off)cb(l.getEntries())});po.observe(type==='event'?{type:type,buffered:true,durationThreshold:16}:{type:type,buffered:true});obs.push(po)}catch(e){}}
try{var nav=performance.getEntriesByType('navigation')[0];if(nav&&nav.responseStart>0)v.ttfb=r2(nav.responseStart)}catch(e){}
watch('paint',function(es){for(var i=0;i<es.length;i++)if(es[i].name==='first-contentful-paint')v.fcp=paints.fcp=r2(es[i].startTime)});
watch('largest-contentful-paint',function(es){var e=es[es.length-1];if(!e)return;v.lcp=paints.lcp=r2(e.startTime);paints.lcp_url=e.url||undefined;paints.lcp_tag=e.element&&e.element.tagName?e.element.tagName.toLowerCase():undefined});
try{if(PerformanceObserver.supportedEntryTypes&&PerformanceObserver.supportedEntryTypes.indexOf('layout-shift')>=0)v.cls=0}catch(e){}
watch('layout-shift',function(es){for(var i=0;i<es.length;i++){var e=es[i];if(e.hadRecentInput||typeof e.value!=='number')continue;cls+=e.value;if(shifts.length<60)shifts.push({t:r2(e.startTime),value:Math.round(e.value*1e4)/1e4})}v.cls=Math.round(cls*1e3)/1e3});
watch('event',function(es){for(var i=0;i<es.length;i++){var e=es[i];if(!e.interactionId)continue;var d=r2(e.duration);if(v.inp===undefined||d>v.inp){v.inp=d;clearTimeout(rs);rs=setTimeout(early,1500)}}});
try{performance.setResourceTimingBufferSize(3000)}catch(e){}watch('resource',function(es){for(var i=0;i<es.length&&seen.length<3000;i++)seen.push(es[i])});
watch('longtask',function(es){for(var i=0;i<es.length;i++)if(longtasks.length<100)longtasks.push({t:r2(es[i].startTime),ms:r2(es[i].duration)})});
try{if(window.Profiler){prof=new Profiler({sampleInterval:10,maxBufferSize:30000});setTimeout(function(){cpu(false)},8000)}}catch(e){prof=null}
function post(body,keep){try{fetch(url,{method:'POST',body:body,keepalive:keep,credentials:'same-origin',headers:{'content-type':'text/plain'}}).catch(function(){})}catch(e){}}
function send(body,slim){if(body.length>60000){if(document.visibilityState==='visible')return post(body,false);body=slim&&slim();if(!body||body.length>60000)return}try{if(navigator.sendBeacon&&navigator.sendBeacon(url,body))return}catch(e){}post(body,true)}
function ext(n){var q=n.indexOf('?'),p=q<0?n:n.slice(0,q),d=p.lastIndexOf('.'),s=p.lastIndexOf('/');return d>s?p.slice(d+1).toLowerCase():''}
var las=null;function linkas(){if(las)return las;las={};try{var ls=document.querySelectorAll('link[href][as],link[rel="modulepreload"][href]');for(var i=0;i<ls.length;i++)las[ls[i].href]=ls[i].getAttribute('as')||'script'}catch(e){}return las}
function kind(r){var x=ext(r.name),it=r.initiatorType;if(x==='woff'||x==='woff2'||x==='ttf'||x==='otf')return'font';if(x==='css')return'css';if(x==='js'||x==='mjs')return'script';if(x==='png'||x==='jpg'||x==='jpeg'||x==='gif'||x==='webp'||x==='avif'||x==='svg')return'img';if(it==='link'){var a=linkas()[r.name];return a?({style:'css',script:'script',font:'font',image:'img',fetch:'fetch'})[a]||'other':'css'}if(it==='css')return'css';if(it==='script')return'script';if(it==='img')return'img';if(it==='fetch'||it==='xmlhttprequest'||it==='beacon')return'fetch';return'other'}
function visit(){las=null;var nav;try{nav=performance.getEntriesByType('navigation')[0]}catch(e){}if(!nav||!(nav.responseStart>0))return null;var res=[],tot={},cnt=0;try{var all=seen.length?seen:performance.getEntriesByType('resource');for(var j=0;j<all.length;j++){var q=all[j];if(q.name.indexOf('/__profiler/')>=0)continue;cnt++;var ty=kind(q),t0=tot[ty]||(tot[ty]={type:ty,count:0,transfer:0,size:0});t0.count++;t0.transfer+=q.transferSize||0;t0.size+=q.decodedBodySize||0}for(var i=0;i<all.length&&res.length<200;i++){var r=all[i];if(r.name.indexOf('/__profiler/')>=0)continue;var o={url:r.name.slice(0,500),type:kind(r),start:r2(r.startTime),end:r2(r.responseEnd||r.startTime+r.duration)};if(r.requestStart)o.req_start=r2(r.requestStart);if(r.responseStart)o.res_start=r2(r.responseStart);if(r.transferSize)o.transfer=r.transferSize;if(r.decodedBodySize)o.size=r.decodedBodySize;if(r.renderBlockingStatus==='blocking')o.blocking=true;res.push(o)}}catch(e){}
var n={req_start:r2(nav.requestStart),res_start:r2(nav.responseStart),res_end:r2(nav.responseEnd)};if(nav.domInteractive)n.dom_interactive=r2(nav.domInteractive);if(nav.domContentLoadedEventEnd)n.dcl=r2(nav.domContentLoadedEventEnd);if(nav.loadEventEnd)n.load=r2(nav.loadEventEnd);if(nav.transferSize)n.transfer=nav.transferSize;if(nav.decodedBodySize)n.size=nav.decodedBodySize;if(nav.nextHopProtocol)n.protocol=nav.nextHopProtocol;
var o2={at:Math.round(performance.timeOrigin),nav:n,paints:paints,resources:res,longtasks:longtasks,islands:[],firsts:[],shifts:shifts,viewport:[innerWidth,innerHeight],ua:navigator.userAgent.slice(0,200)};if(cnt>res.length){o2.resource_totals=Object.keys(tot).map(function(k){return tot[k]});o2.resources_all=cnt}o2.origin=location.origin;try{var st=PerformanceObserver.supportedEntryTypes||[],un=['layout-shift','longtask','event','largest-contentful-paint','long-animation-frame'].filter(function(t){return st.indexOf(t)<0});if(un.length)o2.unsupported=un}catch(e){}if(Object.keys(v).length)o2.vitals=Object.assign({},v);return o2}
function cpu(hiding){if(!prof)return;var p=prof;prof=null;p.stop().then(function(t){if(off||!t)return;var body=JSON.stringify({page:location.pathname,cpu:t});if(hiding&&body.length>60000)return;post(body,!!hiding)},function(){})}
function hide(){if(off||sent)return;sent=true;if(Object.keys(v).length)send(JSON.stringify({page:location.pathname,at:Math.round(performance.timeOrigin),vitals:v}));var vi=visit();if(vi)send(JSON.stringify({page:location.pathname,visit:vi}),function(){return JSON.stringify({page:location.pathname,visit:Object.assign({},vi,{resources:[]})})});cpu(true)}
function early(){if(off)return;var vi=visit();if(vi)send(JSON.stringify({page:location.pathname,visit:vi}))}
document.addEventListener('DOMContentLoaded',function(){
if(document.querySelector('script[data-ogygia-runtime]')){off=true;for(var i=0;i<obs.length;i++)try{obs[i].disconnect()}catch(e){}if(prof){try{prof.stop()}catch(e){}prof=null}return}
document.addEventListener('visibilitychange',function(){document.visibilityState==='hidden'&&hide()});addEventListener('pagehide',hide);
addEventListener('load',function(){setTimeout(early,1500)})});
})();`;
