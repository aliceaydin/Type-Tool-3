/* Final Poster Engine
   - fixed width 80mm (CSS), dynamic height (JS sets mm height)
   - text fit-to-width, distortion from none to extreme (C), but probabilistic
   - text multiplication + overlapping layers with alternating black/white fills
   - frequent, compositional use of shapes (behind, repeating, rhythmic)
   - rotations (90°, 270°) supported
   - no dropdowns; only input + Neu + Drucken
*/

// UI
const input = document.getElementById('replyInput');
const paper = document.getElementById('paper');
const regenBtn = document.getElementById('regenBtn');
const printBtn = document.getElementById('printBtn');
const charCount = document.getElementById('charCount');
const SHAPES_DEFS = document.getElementById('shapes-defs');

// layout constants
const MIN_H_MM = 150;
const MM_PER_CHAR = 1.45;   // controls height growth vs text length
const THROTTLE_MS = 50;
const PADDING = 16;         // internal svg padding in px when composing

// random helpers (crypto)
function rnd() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return (a[0] / 4294967295);
}
function rndInt(a,b){ return Math.floor(rnd()*(b-a+1))+a; }
function rndRange(a,b){ return rnd()*(b-a)+a; }
function pick(arr){ return arr[Math.floor(rnd()*arr.length)]; }

// clone shape defs
function getShapes(){
  if(!SHAPES_DEFS) return [];
  return Array.from(SHAPES_DEFS.children).map(n => n.cloneNode(true));
}

// compute poster height in mm (dynamic)
function computeHeightMm(text){
  const len = (text||'').length;
  const desired = MIN_H_MM + Math.round(len * MM_PER_CHAR);
  return Math.max(MIN_H_MM, desired);
}

// set paper height (mm), return pixel dims after layout
function setPaperHeight(mm){
  paper.style.height = mm + 'mm';
  return new Promise(resolve => requestAnimationFrame(()=>{
    const r = paper.getBoundingClientRect();
    resolve({ w: Math.round(r.width), h: Math.round(r.height) });
  }));
}

// create SVG canvas sized to pixel dims
function createSvg(w,h){
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width','100%');
  svg.setAttribute('height','auto');
  const bg = document.createElementNS(ns,'rect');
  bg.setAttribute('x',0); bg.setAttribute('y',0); bg.setAttribute('width',w); bg.setAttribute('height',h); bg.setAttribute('fill','#fff');
  svg.appendChild(bg);
  return svg;
}

// safe bbox and intersection
function safeBBox(el){
  try{ return el.getBBox(); } catch(e){ return null; }
}
function intersectRect(a,b){
  if(!a||!b) return null;
  const x1 = Math.max(a.x,b.x), y1 = Math.max(a.y,b.y);
  const x2 = Math.min(a.x+a.width, b.x+b.width), y2 = Math.min(a.y+a.height, b.y+b.height);
  if(x2<=x1||y2<=y1) return null;
  return { x:x1, y:y1, width:x2-x1, height:y2-y1 };
}

// add text element with transform options (scaleX, scaleY, skewX)
function addText(svg, x, y, txt, sizePx, anchor='start', weight=900, transformStr=''){
  const ns = 'http://www.w3.org/2000/svg';
  const t = document.createElementNS(ns,'text');
  t.setAttribute('x', x);
  t.setAttribute('y', y);
  t.setAttribute('font-family', 'Helvetica, Arial, sans-serif');
  t.setAttribute('font-size', sizePx);
  t.setAttribute('font-weight', weight);
  t.setAttribute('text-anchor', anchor);
  t.setAttribute('fill', '#000');
  if(transformStr) t.setAttribute('transform', transformStr);
  t.textContent = txt;
  svg.appendChild(t);
  return t;
}

// fit an element horizontally into maxWidth by applying scaleX if necessary
function fitTextToWidth(el, maxWidth, allowScaleX=true){
  const box = safeBBox(el);
  if(!box) return '';
  const currentWidth = box.width;
  if(currentWidth <= maxWidth) return '';
  const sx = maxWidth / currentWidth;
  if(!allowScaleX) return '';
  // apply scale around element origin: translate(-x, -y) scale(sx,1) translate(x,y)
  const x = box.x, y = box.y;
  const prev = el.getAttribute('transform') || '';
  const scaleStr = `translate(${x} ${y}) scale(${sx} 1) translate(${-x} ${-y})`;
  const combined = prev ? prev + ' ' + scaleStr : scaleStr;
  el.setAttribute('transform', combined);
  return combined;
}

// apply vertical stretch/condense and skew randomly within given limits
function applyDistortion(el, maxScaleY=3.5, minScaleX=0.25, maxSkew=18){
  // random decide whether to distort at all
  if(rnd() < 0.45) return ''; // 45% chance no distortion
  // pick intensity with bias: often moderate, sometimes extreme
  const roll = rnd();
  let scaleY, scaleX, skewDeg;
  if(roll < 0.6){
    // small/moderate
    scaleY = rndRange(1.0, 1.6);
    scaleX = rndRange(0.8, 1.0);
    skewDeg = rndRange(-6, 6);
  } else if(roll < 0.9){
    // stronger
    scaleY = rndRange(1.6, Math.min(2.4, maxScaleY));
    scaleX = rndRange(Math.max(minScaleX,0.45), 0.85);
    skewDeg = rndRange(-12, 12);
  } else {
    // extreme
    scaleY = rndRange(2.4, maxScaleY);
    scaleX = rndRange(minScaleX, 0.55);
    skewDeg = rndRange(-maxSkew, maxSkew);
  }
  // compute transform about text center
  const box = safeBBox(el);
  if(!box) return '';
  const cx = box.x + box.width/2;
  const cy = box.y + box.height/2;
  const t = `translate(${cx} ${cy}) skewX(${skewDeg}) scale(${scaleX} ${scaleY}) translate(${-cx} ${-cy})`;
  const prev = el.getAttribute('transform') || '';
  const combined = prev ? prev + ' ' + t : t;
  el.setAttribute('transform', combined);
  return combined;
}

// duplicate text with alternating black/white layers and offsets for visible stacking
function duplicateWithAlternation(svg, baseEl, copies=3, offsetStep=6){
  const ns = 'http://www.w3.org/2000/svg';
  const baseBox = safeBBox(baseEl);
  if(!baseBox) return [];
  const clones = [];
  const parent = svg;
  for(let i=0;i<copies;i++){
    const clone = baseEl.cloneNode(true);
    // alternate fill: even -> black, odd -> white
    const fill = (i % 2 === 0) ? '#000' : '#fff';
    clone.setAttribute('fill', fill);
    // tiny nudge to create layered effect
    const dx = Math.round((i+1) * offsetStep * ((i % 2 === 0) ? 1 : -1));
    const dy = Math.round((i+1) * Math.max(2, offsetStep/2) * ((i % 2 === 0) ? 1 : -1));
    const prevT = clone.getAttribute('transform') || '';
    clone.setAttribute('transform', `${prevT} translate(${dx} ${dy})`);
    parent.appendChild(clone);
    clones.push(clone);
  }
  return clones;
}

// place shape with constrained scaling/rotation so it doesn't escape width by too much
function placeShape(svg, shapeDef, cx, cy, scale, rot, styleMode='fill'){
  const g = shapeDef.cloneNode(true);
  g.setAttribute('transform', `translate(${cx} ${cy}) rotate(${rot}) scale(${scale})`);
  if(styleMode === 'stroke'){
    Array.from(g.querySelectorAll('*')).forEach(el => { el.setAttribute('fill','none'); el.setAttribute('stroke','#000'); el.setAttribute('stroke-width', Math.max(1, 2/scale)); });
  } else {
    Array.from(g.querySelectorAll('*')).forEach(el => { el.setAttribute('fill','#000'); el.setAttribute('stroke','none'); });
  }
  svg.appendChild(g);
  return g;
}

// main compose function: choose a recipe and generate poster
async function compose(text, wPx, hPx){
  while(paper.firstChild) paper.removeChild(paper.firstChild);
  const svg = createSvg(wPx, hPx);
  paper.appendChild(svg);

  const words = (text||'').trim().split(/\s+/).filter(Boolean);
  if(words.length === 0){
    addText(svg, PADDING, Math.round(hPx*0.45), 'type something...', 14, 'start', 700);
    return;
  }

  const shapes = getShapes();

  // choose recipe randomly but weighted towards more dense/typographic outcomes
  const recipes = [recipeVerticalStack, recipeMassShape, recipeMultiplyColumn, recipeGridRhythm];
  const recipe = pick(recipes.concat([recipeVerticalStack, recipeMassShape])); // bias
  await recipe(svg, words, shapes, wPx, hPx);

  // post-process overlap handling: if text overlaps shape heavily, alternate white/black masks
  const textEls = Array.from(svg.querySelectorAll('text')).map(t => ({ el: t, box: safeBBox(t) })).filter(x=>x.box);
  const shapeEls = Array.from(svg.querySelectorAll('g')).filter(g => g.parentNode === svg).map(g => ({ el:g, box: safeBBox(g) })).filter(x=>x.box);

  textEls.forEach(t => {
    shapeEls.forEach(s => {
      const inter = intersectRect(t.box, s.box);
      if(!inter) return;
      const p = rnd();
      if(p > 0.66){
        // clean white mask
        placeWhiteMask(svg, inter);
      } else if(p > 0.33){
        // invert text fill in place (white)
        try { t.el.setAttribute('fill', '#fff'); } catch(e){}
      } else {
        // desaturate shape
        try { Array.from(s.el.querySelectorAll('*')).forEach(ch => { ch.setAttribute('fill','#fff'); ch.setAttribute('stroke','#fff'); }); } catch(e){}
      }
    });
  });

  // final small label bottom-left
  addText(svg, PADDING, Math.round(hPx - 6), words.slice(0,2).join(' '), 9, 'start', 700);
}

/* --------------------
   Recipes: compositional building blocks
   -------------------- */

// Recipe A: Vertical Power Stack (large stacked words, shape behind, occasional duplicates & distortion)
async function recipeVerticalStack(svg, words, shapes, wPx, hPx){
  const HEAD_MAX = Math.round(hPx * 0.30);
  const HEAD_MIN = Math.round(hPx * 0.12);
  const lines = words.slice(0, Math.min(4, words.length));
  let y = Math.round(hPx * 0.16);

  // Big vertical stack left-aligned, but fit to width
  for(let i=0;i<lines.length;i++){
    const w = lines[i];
    const size = Math.round(rndRange(HEAD_MAX * (1 - i*0.1), HEAD_MAX * (0.9 - i*0.05)));
    const x = PADDING;
    const t = addText(svg, x, y, w, size, 'start', 900, '');
    // fit to width if needed
    const allowedWidth = wPx - PADDING*2;
    fitTextToWidth(t, allowedWidth, true);
    // random distortion (none..extreme)
    applyDistortion(t, 3.5, 0.25, 18);
    // occasionally duplicate with alternating fills
    if(rnd() > 0.4){
      const copies = rndInt(1,4);
      duplicateWithAlternation(svg, t, copies, Math.round(size*0.03 + 4));
    }
    y += Math.round(size * rndRange(0.86, 1.05));
  }

  // large background shape behind the top block (placed early so it's behind)
  if(shapes.length && rnd() > 0.2){
    const s = pick(shapes);
    const scale = rndRange(0.7, 1.4);
    const cx = Math.round(wPx * rndRange(0.55, 0.9));
    const cy = Math.round(hPx * rndRange(0.2, 0.45));
    const rot = pick([0,90,270]);
    const g = placeShape(svg, s, cx, cy, scale, rot, (scale>0.9)?'stroke':'fill');
    // lower z-order: move to beginning (behind text)
    svg.insertBefore(g, svg.firstChild);
  }

  // small repeated words down the bottom to create rhythm
  if(words.length > 1 && rnd() > 0.3){
    const rep = words[0];
    const sizeSmall = Math.round(Math.max(8, HEAD_MIN * 0.20));
    let yy = Math.round(hPx * 0.7);
    const count = rndInt(3, 8);
    for(let i=0;i<count;i++){
      const x = PADDING + rndInt(0, 6);
      const t = addText(svg, x, yy + i * Math.round(sizeSmall*1.2), rep, sizeSmall, 'start', 700, pick([0,90]));
      if(rnd() > 0.5) duplicateWithAlternation(svg, t, rndInt(1,3), 4);
    }
  }
}

// Recipe B: Massive Shape Background + Centered Headline repeated for texture
async function recipeMassShape(svg, words, shapes, wPx, hPx){
  // big shape as backbone
  if(shapes.length){
    const s = pick(shapes);
    const scale = rndRange(1.0, 1.8);
    const cx = Math.round(wPx * rndRange(0.35, 0.65));
    const cy = Math.round(hPx * rndRange(0.3, 0.55));
    const rot = pick([0,90,270]);
    const g = placeShape(svg, s, cx, cy, scale, rot, 'fill');
    svg.insertBefore(g, svg.firstChild);
  }

  // centered headline
  const headline = words.slice(0, Math.min(2, words.length)).join(' ');
  const size = Math.round(hPx * rndRange(0.18, 0.32));
  const cxText = Math.round(wPx / 2);
  let cyText = Math.round(hPx * rndRange(0.38, 0.5));
  const main = addText(svg, cxText, cyText, headline, size, 'middle', 900);
  fitTextToWidth(main, wPx - PADDING*2, false); // prefer vertical scaling over horizontal condensing here

  // vertical/horizontal distortion optionally
  if(rnd() > 0.4) applyDistortion(main, 3.5, 0.25, 18);

  // stacked duplicates for texture
  const dupCount = rndInt(1,4);
  for(let i=0;i<dupCount;i++){
    cyText += Math.round(size * rndRange(0.24, 0.5));
    const dup = addText(svg, cxText + Math.round(size*0.02*i), cyText, headline, Math.round(size * rndRange(0.2, 0.34)), 'middle', 700);
    if(rnd() > 0.3) duplicateWithAlternation(svg, dup, rndInt(1,3), 5);
  }

  // small shapes in column to the side for rhythm
  const shapeCount = rndInt(1,4);
  for(let i=0;i<shapeCount;i++){
    if(!shapes.length) break;
    const s = pick(shapes);
    const g = s.cloneNode(true);
    const sc = rndRange(0.08, 0.6);
    const px = Math.round(wPx - PADDING - rndRange(10, 40));
    const py = Math.round(hPx * rndRange(0.12, 0.88));
    g.setAttribute('transform', `translate(${px} ${py}) scale(${sc}) rotate(${pick([0,0,90])})`);
    Array.from(g.querySelectorAll('*')).forEach(el => { el.setAttribute('fill','#000'); el.setAttribute('stroke','none'); });
    svg.appendChild(g);
  }
}

// Recipe C: Multiply Column — many repetitions stacked to create texture; vertical rotated sidebar
async function recipeMultiplyColumn(svg, words, shapes, wPx, hPx){
  const main = words[0];
  const repeat = Math.max(6, Math.floor(hPx / 40));
  const sizeMain = Math.round(hPx * rndRange(0.06, 0.14));
  let y = Math.round(hPx * 0.06);
  for(let i=0;i<repeat;i++){
    const x = PADDING + Math.round(rndRange(0,4));
    const rot = pick([0,0,90,270,0]);
    const t = addText(svg, x, y, (i%2===0) ? main.toUpperCase() : main.toLowerCase(), sizeMain, 'start', 800, rot === 0 ? '' : `rotate(${rot} ${x} ${y})`);
    // fit horizontally if needed (rotate-aware)
    fitTextToWidth(t, wPx - PADDING*2, true);
    // sometimes distort a line
    if(rnd() > 0.7) applyDistortion(t, 3.5, 0.25, 18);
    // sometimes multiply individual lines with alternation
    if(rnd() > 0.6){
      duplicateWithAlternation(svg, t, rndInt(1,4), Math.round(sizeMain*0.04 + 3));
    }
    y += Math.round(sizeMain * rndRange(0.7, 1.35));
  }

  // vertical rotated long phrase at right
  if(words.length > 1 && rnd() > 0.3){
    const side = words.slice(1).join(' ');
    const sizeSide = Math.round(hPx * rndRange(0.12, 0.22));
    const x = Math.round(wPx - PADDING/2);
    const yMid = Math.round(hPx * 0.5);
    const t = addText(svg, x, yMid, side, sizeSide, 'middle', 900, `rotate(90 ${x} ${yMid})`);
    fitTextToWidth(t, hPx * 0.9, true);
  }

  // sprinkle many small shapes for texture
  const many = rndInt(2,6);
  for(let i=0;i<many;i++){
    if(!shapes.length) break;
    const s = pick(shapes);
    const g = s.cloneNode(true);
    const sc = rndRange(0.06, 0.3);
    const cx = Math.round(rndRange(PADDING, wPx - PADDING));
    const cy = Math.round(rndRange(PADDING, hPx - PADDING));
    const rot = pick([0,0,90,270]);
    g.setAttribute('transform', `translate(${cx} ${cy}) rotate(${rot}) scale(${sc})`);
    Array.from(g.querySelectorAll('*')).forEach(el => { el.setAttribute('fill','#000'); el.setAttribute('stroke','none'); });
    svg.appendChild(g);
  }
}

// Recipe D: Grid Rhythm — left strong headline + right grid of small items and shapes
async function recipeGridRhythm(svg, words, shapes, wPx, hPx){
  const phrase = words.slice(0, Math.min(3, words.length)).join(' ');
  const size = Math.round(hPx * rndRange(0.16, 0.26));
  const x = PADDING;
  const y = Math.round(hPx * rndRange(0.28, 0.42));
  const main = addText(svg, x, y, phrase, size, 'start', 900, '');
  fitTextToWidth(main, Math.round(wPx * 0.55) - PADDING, true);
  if(rnd() > 0.4) applyDistortion(main, 3.5, 0.25, 18);

  // grid on right
  const cols = 2;
  const rows = rndInt(3,7);
  const gap = Math.round((wPx - (wPx*0.55) - PADDING*2) / cols);
  const startX = Math.round(wPx*0.55);
  let cy = Math.round(hPx * 0.12);
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const px = startX + c * gap + rndInt(-6,6);
      const py = cy + r * Math.round(size*0.5) + rndInt(-6,6);
      if(rnd() > 0.5 && shapes.length){
        const s = pick(shapes);
        const g = s.cloneNode(true);
        const sc = rndRange(0.06, 0.36);
        const rot = pick([0,0,90]);
        g.setAttribute('transform', `translate(${px} ${py}) rotate(${rot}) scale(${sc})`);
        if(sc>0.5) Array.from(g.querySelectorAll('*')).forEach(el => { el.setAttribute('fill','none'); el.setAttribute('stroke','#000'); el.setAttribute('stroke-width', Math.max(1,2/sc)); });
        else Array.from(g.querySelectorAll('*')).forEach(el => { el.setAttribute('fill','#000'); el.setAttribute('stroke','none'); });
        svg.appendChild(g);
      } else {
        const small = words[rndInt(0, words.length-1)];
        const t = addText(svg, px, py, small, Math.round(size*0.18), 'start', 700, pick([0,90]));
        if(rnd() > 0.5) duplicateWithAlternation(svg, t, rndInt(1,3), 3);
      }
    }
  }
}

/* --------------------
   UI wiring & throttling
   -------------------- */

let timer = null;
function scheduleRender(){
  const val = input.value || '';
  charCount.textContent = `${val.length}/${input.maxLength}`;
  const mm = computeHeightMm(val);
  setPaperHeight(mm).then(dim => {
    if(timer) clearTimeout(timer);
    timer = setTimeout(()=> compose(val, dim.w, dim.h), THROTTLE_MS);
  });
}

input.addEventListener('input', scheduleRender);
regenBtn.addEventListener('click', scheduleRender);
printBtn.addEventListener('click', ()=> window.print());

// initial example
input.value = '';
scheduleRender();

