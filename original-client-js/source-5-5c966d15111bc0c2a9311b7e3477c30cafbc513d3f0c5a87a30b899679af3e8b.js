/* 框內由 desk.html 決定橫式 / 直式;轉向 / 電腦模式切換只改版面,不重新載入。
   框外網址 ?land=1 = 強制開橫式。 */
(function(){var inDesk=false;try{inDesk=window.top!==window&&!!parent.deskScale;}catch(e){}
var force=/[?&]land=1/.test(location.search);
var coarse=matchMedia("(pointer: coarse)"),mq=matchMedia("(orientation: landscape)");
var root=document.documentElement;
var fittedWidth=0,fittedHeight=0;
// 與 desk.html 相同的方向來源;框內只跟隨 parent.deskLand。
function isLandscape(){
  var o=screen.orientation;
  if(o&&/^(landscape|portrait)-/.test(o.type))return o.type.indexOf('landscape')===0;
  var angle=o&&typeof o.angle==='number'&&isFinite(o.angle)?o.angle:window.orientation;
  if(typeof angle==='number'&&isFinite(angle))return Math.abs(angle)%180===90;
  if(screen.width>0&&screen.height>0)return screen.width>screen.height;
  return mq.matches;
}
function hasInput(doc){
  var el=doc.activeElement;
  if(!el)return false;
  if(/^(INPUT|TEXTAREA)$/.test(el.tagName)||el.isContentEditable)return true;
  try{return el.tagName==='IFRAME'&&!!el.contentDocument&&hasInput(el.contentDocument);}catch(e){return false;}
}
function apply(rotated){
  var on;
  if(inDesk)on=parent.deskLand;
  else{
    var width=innerWidth,height=innerHeight;
    if(coarse.matches&&rotated!==true&&(hasInput(document)||(Math.abs(width-fittedWidth)<=2&&height<fittedHeight)))return;
    fittedWidth=width;fittedHeight=height;
    on=force||(coarse.matches&&isLandscape());
  }
  if(root.classList.contains("land")===on)return;
  root.classList.toggle("land",on);setTimeout(function(){dispatchEvent(new Event("resize"));},50);
}
function rotate(){apply(true);}
apply();if(mq.addEventListener)mq.addEventListener("change",apply);else if(mq.addListener)mq.addListener(apply);
if(coarse.addEventListener)coarse.addEventListener("change",apply);else if(coarse.addListener)coarse.addListener(apply);
addEventListener("resize",apply);
addEventListener("orientationchange",rotate);
if(screen.orientation&&screen.orientation.addEventListener)screen.orientation.addEventListener("change",rotate);
document.addEventListener("focusout",function(){setTimeout(apply,0);});
var l=document.createElement("link");l.rel="stylesheet";l.href="land.css?v=f41f04e511";document.head.appendChild(l);
var sc=document.createElement("script");sc.src="land.js?v=7f6db26ca5";sc.defer=true;document.head.appendChild(sc);})();