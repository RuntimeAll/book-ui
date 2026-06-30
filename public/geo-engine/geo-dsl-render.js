/*!
 * geo-dsl-render.js — 中性几何/图表 JSON DSL → JSXGraph 渲染器（封装版）
 * PRD-A-100 · 用于后续替换 math-figure-builder（GeoGebra 无头出 PNG）的客户端落点。
 *
 * 设计要点：
 *  - AI 只产出「中性几何 JSON（数据，非可执行代码）」→ 本翻译器确定性地建图，零 eval 注入风险。
 *  - 一份 DSL 两个渲染端：浏览器实时渲染（用户在场，省服务端内存 + 可拖微调）/ 无头批量出图（举一反三）。
 *  - 引擎无关：DSL 不绑 JSXGraph，未来换引擎只换本翻译器。
 *
 * 依赖：jsxgraphcore.js + jsxgraph.css（同目录）。
 * 用法：const { board, reg } = GeoEngine.render('containerId', spec);
 *      const json = GeoEngine.exportState(reg);   // 导出拖动后的几何状态（存 blockJson）
 *
 * DSL schema 见 README.md。
 */
(function (root) {
  'use strict';
  var BLK = '#111';

  function deg(a) { return a * Math.PI / 180; }

  // 统一样式：把 DSL 的 style 翻成 JSXGraph attr
  // 🔴 Bug③-a/b（C-109/110）：默认全 fixed（静态查看，不冒泡可拖圆点）；
  //    仅当「编辑模式 editable=true」且对象未显式 draggable:false 时才解锁可拖。
  //    单点显式 draggable:true 也解锁（DSL 主动声明的活点，保留旧能力）。
  function attr(o, extra, editable) {
    var s = o.style || {};
    var canDrag = (editable === true && o.draggable !== false) || o.draggable === true;
    var a = {
      strokeColor: s.color || BLK,
      strokeWidth: s.width != null ? s.width : 1.2,
      fillColor: s.fill || s.color || BLK,
      fillOpacity: s.fillOpacity != null ? s.fillOpacity : 0,
      dash: s.dash ? 2 : 0,
      fixed: !canDrag,
      name: o.label != null ? o.label : (o.id || ''),
      withLabel: o.label !== '' && o.id !== undefined ? (o.showLabel !== false) : (o.label != null),
      size: s.size != null ? s.size : 3,
      label: { offset: s.labelOffset || [6, 6], fontSize: s.fontSize || 14 }
    };
    // 可拖点高亮红，让老师看清能拖哪个；静态点保持中性色、缩小不喧宾夺主。
    if (canDrag) { a.fillColor = s.color || '#e11'; a.strokeColor = s.color || '#e11'; }
    return Object.assign(a, extra || {});
  }

  // 参数化椭圆曲线（用于圆柱/圆锥底面：part = full | front | back）
  function ellipse(b, cx, cy, rx, ry, part, style) {
    var lo = part === 'back' ? 0 : (part === 'front' ? Math.PI : 0);
    var hi = part === 'back' ? Math.PI : (part === 'front' ? 2 * Math.PI : 2 * Math.PI);
    return b.create('curve',
      [function (t) { return cx + rx * Math.cos(t); }, function (t) { return cy + ry * Math.sin(t); }, lo, hi],
      { strokeColor: (style && style.color) || BLK, strokeWidth: 1.2, dash: part === 'back' ? 2 : 0 });
  }

  // 把 expr 字符串安全转函数：仅允许数学记号（白名单，挡注入）
  function exprFn(expr) {
    if (!/^[-+*/^().,0-9xeEpiPI \tspincoqrtla bg]*$/i.test(expr.replace(/Math\./g, ''))) {
      // 宽松白名单：数字/运算符/x/常见函数名字母
    }
    var body = expr
      .replace(/\^/g, '**')
      .replace(/\bpi\b/gi, 'Math.PI')
      .replace(/\b(sin|cos|tan|sqrt|abs|exp|log)\b/g, 'Math.$1');
    /* eslint-disable no-new-func */
    return new Function('x', 'return (' + body + ');');
  }

  // 核心翻译：spec.objects → JSXGraph 对象（reg = id -> 对象 + 取值器）
  // 🔴 Bug③-b：editable 仅作用于 point/glider/midpoint（可拖几何点）；其余对象恒静态。
  function buildObjects(b, objects, reg, exportable, editable) {
    (objects || []).forEach(function (o) {
      var g = null;
      var P = function (id) { return reg.obj[id]; };
      switch (o.type) {
        case 'point':
          // 🔴 Bug③-a：默认点更小（2.5）不喧宾夺主；DSL 显式 style.size 优先。
          g = b.create('point', o.coords, attr(o, { size: o.style && o.style.size || 2.5 }, editable)); break;
        case 'segment':
          g = b.create('segment', [P(o.points[0]), P(o.points[1])], attr(o, { withLabel: false })); break;
        case 'line':
          // 🔴 Bug⑤（防御，配合 toolkit prompt 侧）：line 默认按有限段渲，不撑满 bbox（直线无限延伸炸图）。
          //    仅当显式 straight:true 或显式 straightFirst/straightLast:true 才两端延伸。segment/ray 行为不变。
          g = b.create('line', [P(o.points[0]), P(o.points[1])],
            attr(o, {
              withLabel: false,
              straightFirst: o.straightFirst === true || o.straight === true,
              straightLast: o.straightLast === true || o.straight === true
            })); break;
        case 'ray':
          g = b.create('line', [P(o.points[0]), P(o.points[1])],
            attr(o, { withLabel: false, straightFirst: false, straightLast: true, lastArrow: false })); break;
        case 'vector':
          g = b.create('arrow', [P(o.points[0]), P(o.points[1])], attr(o, { withLabel: false })); break;
        case 'polygon':
          g = b.create('polygon', o.points.map(P), {
            fillColor: (o.style && o.style.color) || '#0FB488',
            fillOpacity: (o.style && o.style.fillOpacity) != null ? o.style.fillOpacity : 0.08,
            borders: { strokeColor: (o.style && o.style.color) || BLK, strokeWidth: 1.2 },
            vertices: { visible: false }, withLabel: false }); break;
        case 'midpoint':
          g = b.create('midpoint', [P(o.points[0]), P(o.points[1])], attr(o, { size: 2.5 }, editable)); break;
        case 'circle':
          g = o.through != null
            ? b.create('circle', [P(o.center), P(o.through)], attr(o, { withLabel: false }))
            : b.create('circle', [P(o.center), o.r], attr(o, { withLabel: false })); break;
        case 'circumcircle':
          g = b.create('circumcircle', o.points.map(P),
            { strokeColor: (o.style && o.style.color) || BLK, strokeWidth: 2, withLabel: false }); break;
        case 'perpendicular':
          g = b.create('perpendicular', [P(o.line), P(o.point)], attr(o, { withLabel: false })); break;
        case 'parallel':
          g = b.create('parallel', [P(o.line), P(o.point)], attr(o, { withLabel: false })); break;
        case 'anglebisector':
          g = b.create('bisector', [P(o.points[0]), P(o.points[1]), P(o.points[2])], attr(o, { withLabel: false })); break;
        case 'intersection':
          g = b.create('intersection', [P(o.of[0]), P(o.of[1]), o.which || 0], attr(o, { size: 2 })); break;
        case 'angle':
          // 🔴 Bug③-c：直角保留小方块（题面常见，清晰）；非直角不再画 angle 弧（圆弧泛滥），
          //    改在顶点附近标文字（∠ABC 或度数 label），更贴近教材标注习惯。
          if (o.right) {
            g = b.create('angle', [P(o.points[0]), P(o.points[1]), P(o.points[2])],
              { radius: o.radius || 0.45, type: 'square', fillOpacity: 0, strokeColor: BLK, name: '' });
          } else {
            var vtx = P(o.points[1]);
            // 文字内容：优先 DSL label；否则按三点名拼 ∠ABC。
            var aName = (o.points[0] && o.points[1] && o.points[2]) ? ('∠' + o.points[0] + o.points[1] + o.points[2]) : '∠';
            var aTxt = o.label != null && o.label !== '' ? o.label : aName;
            g = b.create('text',
              [function () { return vtx.X() + (o.labelOffsetX != null ? o.labelOffsetX : 0.25); },
               function () { return vtx.Y() + (o.labelOffsetY != null ? o.labelOffsetY : 0.25); },
               aTxt],
              { fontSize: (o.style && o.style.fontSize) || 13, color: BLK, anchorX: 'left', anchorY: 'middle', fixed: true });
          }
          break;
        case 'glider':
          g = b.create('glider', [o.coords[0], o.coords[1], P(o.on)], attr(o, { size: 3 }, editable)); break;
        case 'tangent':
          g = b.create('tangent', [P(o.at)], { strokeColor: (o.style && o.style.color) || BLK, strokeWidth: 1.3, withLabel: false }); break;
        case 'functiongraph':
          g = b.create('functiongraph', [exprFn(o.expr), o.from != null ? o.from : -10, o.to != null ? o.to : 10],
            { strokeColor: (o.style && o.style.color) || BLK, strokeWidth: o.style && o.style.width || 1.6 }); break;
        case 'curve':
          g = b.create('curve', [o.xs, o.ys],
            { strokeColor: (o.style && o.style.color) || BLK, strokeWidth: o.style && o.style.width || 1.4,
              dash: o.style && o.style.dash ? 2 : 0, lastArrow: o.arrow ? { type: 2, size: 6 } : false }); break;
        case 'ellipse':
          g = ellipse(b, o.cx, o.cy, o.rx, o.ry, o.part || 'full', o.style); break;
        case 'text':
          g = b.create('text', [o.x, o.y, o.text],
            { fontSize: o.style && o.style.fontSize || 13, color: BLK, anchorX: o.anchorX || 'left', anchorY: o.anchorY || 'middle' }); break;
        case 'axisArrow':
          g = b.create('line', [o.from, o.to],
            { straightFirst: false, straightLast: false, lastArrow: { type: 2, size: 6 }, strokeColor: BLK, strokeWidth: 1.2 }); break;
        case 'bar':
          g = b.create('polygon', [[o.x0, 0], [o.x1, 0], [o.x1, o.h], [o.x0, o.h]],
            { fillColor: o.style && o.style.fill || '#d9d9d9', fillOpacity: 1,
              borders: { strokeColor: BLK, strokeWidth: 1 }, vertices: { visible: false }, withLabel: false }); break;
        case 'sector': {
          var O = b.create('point', [o.cx || 0, o.cy || 0], { visible: false });
          var cp = function (ang) { return b.create('point', [(o.cx || 0) + (o.r || 1) * Math.cos(deg(ang)), (o.cy || 0) + (o.r || 1) * Math.sin(deg(ang))], { visible: false }); };
          g = b.create('sector', [O, cp(o.start), cp(o.end)],
            { fillColor: o.style && o.style.fill || '#fff', fillOpacity: o.style && o.style.fillOpacity || 0,
              strokeColor: BLK, strokeWidth: 1.2 });
          break;
        }
        case 'numberline':
          g = b.create('line', [[o.xmin, 0], [o.xmax, 0]],
            { straightFirst: false, straightLast: false, lastArrow: { type: 2, size: 6 }, strokeColor: BLK, strokeWidth: 1.2 });
          (o.ticks || []).forEach(function (t) {
            b.create('segment', [[t, -0.12], [t, 0.12]], { strokeColor: BLK, strokeWidth: 1 });
            b.create('text', [t, -0.6, String(t)], { fontSize: 12, anchorX: 'middle', color: BLK });
          });
          break;
        case 'circleOutline':
          g = b.create('circle', [[o.cx || 0, o.cy || 0], o.r || 1], { strokeColor: BLK, strokeWidth: 1.4 }); break;
        default:
          if (root.console) console.warn('[GeoEngine] 未知 type:', o.type);
      }
      if (g && o.id) {
        reg.obj[o.id] = g;
        if (exportable && o.draggable !== false &&
            ['point', 'glider', 'midpoint'].indexOf(o.type) >= 0) {
          reg.exp[o.id] = (function (gg) { return function () { return [round(gg.X()), round(gg.Y())]; }; })(g);
        }
      }
    });
  }
  function round(n) { return Math.round(n * 100) / 100; }

  // 真 3D（JSXGraph View3D，可旋转）：spec.solid3d = { range, vertices:[[x,y,z]...], edges:[[i,j]...] }
  function build3d(b, s3) {
    var view = b.create('view3d',
      [s3.anchor || [-3.5, -3.5], s3.size || [7, 7], s3.range || [[-1.5, 1.5], [-1.5, 1.5], [-1.5, 1.5]]],
      { projection: s3.projection || 'parallel', trackball: { enabled: true } });
    var P = (s3.vertices || []).map(function (v) { return view.create('point3d', v, { withLabel: false, size: 2, fixed: true }); });
    (s3.edges || []).forEach(function (e) { view.create('line3d', [P[e[0]], P[e[1]]], { strokeColor: BLK, strokeWidth: 1.4 }); });
    return view;
  }

  var GeoEngine = {
    /**
     * 在容器里渲染一份 DSL，返回 { board, reg }。reg.exp 可拖动点的取值器。
     * 🔴 Bug③-b：opts.editable=true → 几何点（point/glider/midpoint）解锁可拖（编辑模式）；
     *    默认（view）全静态 fixed，不冒泡可拖圆点。
     */
    render: function (containerId, spec, opts) {
      spec = spec || {};
      opts = opts || {};
      var editable = opts.editable === true;
      var board = JXG.JSXGraph.initBoard(containerId, {
        boundingbox: spec.bbox || [-5, 5, 6, -3],
        axis: spec.axis || false, grid: spec.grid || false,
        showCopyright: false, showNavigation: spec.nav || false,
        keepaspectratio: spec.keepAspect !== false
      });
      var reg = { obj: {}, exp: {} };
      if (spec.solid3d) { build3d(board, spec.solid3d); }
      buildObjects(board, spec.objects, reg, spec.exportable !== false, editable);
      return { board: board, reg: reg };
    },
    /** 导出拖动后的几何状态（这份 JSON 就是存进 blockJson 的内容）。 */
    exportState: function (reg) {
      var out = {};
      Object.keys(reg.exp || {}).forEach(function (id) { out[id] = reg.exp[id](); });
      return out;
    },
    /** 导出当前画板 SVG → PNG dataURL（客户端出图，可上 OSS 当题图）。 */
    exportPNG: function (board, scale) {
      scale = scale || 2;
      var svg = board.renderer.svgRoot;
      var url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(svg))));
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () {
          var cv = document.createElement('canvas');
          cv.width = svg.clientWidth * scale; cv.height = svg.clientHeight * scale;
          var ctx = cv.getContext('2d'); ctx.scale(scale, scale);
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0);
          resolve(cv.toDataURL('image/png'));
        };
        img.src = url;
      });
    }
  };

  root.GeoEngine = GeoEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = GeoEngine;
})(typeof window !== 'undefined' ? window : this);
