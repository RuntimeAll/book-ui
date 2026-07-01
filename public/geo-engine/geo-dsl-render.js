/*!
 * geo-dsl-render.js — 中性几何/图表 JSON DSL → JSXGraph 渲染器（统一增强版）
 *
 * 谱系：PRD-A-100 geo-dsl-render（variant 生产在用） ⊕ codeplace-C/geometry-board geo-render（增强分支）。
 * 本版把两支合一，两边能力都保：
 *   [来自 variant 生产分支] editable 可拖模式（老师拖调点，红色高亮）+ exportState + 真 3D(View3D) + angle 文字兜底。
 *   [来自 geometry-board 增强分支]
 *     🔴 标签自动避让 autoPosition —— agent 出图最大痛点「字母压线/压点」由渲染层解决（学自 sjep.net，同基 JSXGraph）。
 *     🔴 三态：readonly（只读，隐藏几何顶点圆点、只留字母=教科书样式）/ editable（可拖）/ 默认静态查看。
 *     🔴 实心点（GeoGebra 风蓝点）、arc 圆弧、display:'internal'（SVG 内联文本，exportSVG 带得上标签）。
 *     🔴 高层「构件 DSL」（spec.build）自动经 FigureBuilder 展开成低层 DSL（代码精确解坐标 + auto-bbox）。
 *
 * 设计不变量：AI 只产「中性几何 JSON（数据非代码）」→ 确定性建图，零 eval 注入；引擎无关（换引擎只换本翻译器）。
 * 依赖：jsxgraphcore.js + jsxgraph.css（同目录）；高层构件另需 figure-builder.js（可选，缺省则只吃低层 DSL）。
 * 用法：const { board, reg } = GeoEngine.render('containerId', spec, { editable });
 */
(function (root) {
  'use strict';
  var BLK = '#111';
  var POINT = '#1a73e8';   // 默认点色：实心蓝（GeoGebra 风），可被 style.color 覆盖

  // 标签自动避让默认参数（与 JSXGraph 内置一致，可被 spec.label 覆盖）
  var LABEL_AUTO_DEFAULT = {
    autoPosition: true,
    autoPositionMinDistance: 12,
    autoPositionMaxDistance: 28,
    offset: [10, 10],
    fontSize: 14,
    display: 'internal'
  };

  function deg(a) { return a * Math.PI / 180; }
  function round(n) { return Math.round(n * 100) / 100; }

  function labelAttr(o, globalLabel) {
    var s = o.style || {};
    var base = Object.assign({}, LABEL_AUTO_DEFAULT, globalLabel || {});
    if (s.labelOffset) base.offset = s.labelOffset;
    if (s.fontSize) base.fontSize = s.fontSize;
    if (o.autoLabel === false) base.autoPosition = false;
    return base;
  }

  // 统一样式：DSL style → JSXGraph attr
  // 🔴 editable=true 且对象未显式 draggable:false → 解锁可拖（红色高亮，老师看清能拖哪个）；
  //    单点显式 draggable:true 也解锁（DSL 主动声明的活点）。默认全 fixed（静态查看）。
  function attr(o, globalLabel, extra, editable) {
    var s = o.style || {};
    var canDrag = (editable === true && o.draggable !== false) || o.draggable === true;
    var a = {
      strokeColor: s.color || BLK,
      strokeWidth: s.width != null ? s.width : 1.2,
      fillColor: s.fill || s.color || BLK,
      fillOpacity: s.fillOpacity != null ? s.fillOpacity : 0,
      dash: s.dash ? 2 : 0,
      fixed: !canDrag,
      name: o.label != null ? o.label : '',
      withLabel: (o.label != null && o.label !== '') ? (o.showLabel !== false) : false,  // 只在显式非空 label 时显示（防内部 id 泄漏成标签）
      size: s.size != null ? s.size : 3,
      label: labelAttr(o, globalLabel)
    };
    if (canDrag) { a.fillColor = s.color || '#e11'; a.strokeColor = s.color || '#e11'; }
    if (o.hidden) { a.visible = false; a.withLabel = false; }   // 隐藏点（立体顶点等，只当连线端点用）
    return Object.assign(a, extra || {});
  }

  // 参数化椭圆曲线（圆柱/圆锥底面：part = full | front | back）
  function ellipse(b, cx, cy, rx, ry, part, style) {
    var lo = part === 'back' ? 0 : (part === 'front' ? Math.PI : 0);
    var hi = part === 'back' ? Math.PI : (part === 'front' ? 2 * Math.PI : 2 * Math.PI);
    return b.create('curve',
      [function (t) { return cx + rx * Math.cos(t); }, function (t) { return cy + ry * Math.sin(t); }, lo, hi],
      { strokeColor: (style && style.color) || BLK, strokeWidth: 1.2, dash: part === 'back' ? 2 : 0 });
  }

  // expr 字符串安全转函数：仅允许数学记号（白名单，挡注入）
  function exprFn(expr) {
    var body = String(expr)
      .replace(/\^/g, '**')
      .replace(/\bpi\b/gi, 'Math.PI')
      .replace(/\b(sin|cos|tan|asin|acos|atan|sqrt|abs|exp|log|min|max)\b/g, 'Math.$1');
    if (!/^[-+*/().,0-9xeE\sA-Za-z]*$/.test(body.replace(/Math\.[A-Za-z]+|\*\*/g, ''))) {
      throw new Error('[GeoEngine] 非法 expr: ' + expr);
    }
    /* eslint-disable no-new-func */
    return new Function('x', 'return (' + body + ');');
  }

  // 核心翻译：spec.objects → JSXGraph 对象（reg = id -> 对象 + 取值器）
  // ro = 只读（点不可拖，几何顶点只留字母不画圆点）；editable = 可拖编辑模式
  function buildObjects(b, objects, reg, exportable, globalLabel, ro, editable) {
    (objects || []).forEach(function (o) {
      var g = null;
      var P = function (id) { return reg.obj[id]; };
      var A = function (extra) { return attr(o, globalLabel, extra, editable); };
      switch (o.type) {
        case 'point': {
          var ps = o.style || {};
          var pa = A({ size: ps.size || 2.5 });
          if (pa.fixed) {   // 非可拖（静态/只读）→ 蓝色实心内容点
            var pcol = ps.color || POINT;
            pa.strokeColor = pcol; pa.fillColor = ps.fill || pcol;
            pa.fillOpacity = ps.fillOpacity != null ? ps.fillOpacity : 1;   // 🔴 实心
            pa.strokeWidth = 1; pa.highlightFillColor = pcol; pa.highlightStrokeColor = pcol;
            if (ro && !o.keepDot) {   // 只读：默认藏所有点（只留字母），除非内容点(keepDot)
              pa.strokeOpacity = 0; pa.fillOpacity = 0; pa.highlightStrokeOpacity = 0; pa.highlightFillOpacity = 0;
            }
          }
          g = b.create('point', o.coords, pa); break;
        }
        case 'segment':
          g = b.create('segment', [P(o.points[0]), P(o.points[1])], A({ withLabel: false })); break;
        case 'line':
          g = b.create('line', [P(o.points[0]), P(o.points[1])],
            A({ withLabel: false, straightFirst: o.straightFirst !== false, straightLast: o.straightLast !== false })); break;
        case 'ray':
          g = b.create('line', [P(o.points[0]), P(o.points[1])],
            A({ withLabel: false, straightFirst: false, straightLast: true, lastArrow: false })); break;
        case 'vector':
          g = b.create('arrow', [P(o.points[0]), P(o.points[1])], A({ withLabel: false })); break;
        case 'polygon':
          g = b.create('polygon', o.points.map(P), {
            fillColor: (o.style && o.style.color) || '#0FB488',
            fillOpacity: (o.style && o.style.fillOpacity) != null ? o.style.fillOpacity : 0.08,
            borders: { strokeColor: (o.style && o.style.color) || BLK, strokeWidth: 1.2 },
            vertices: { visible: false }, withLabel: false }); break;
        case 'midpoint': {
          var ma = A({ size: 2.5 });
          if (ma.fixed) {
            ma.strokeColor = POINT; ma.fillColor = POINT; ma.fillOpacity = 1; ma.strokeWidth = 1;
            if (ro && (o.label == null || o.label === '')) { ma.strokeOpacity = 0; ma.fillOpacity = 0; ma.highlightStrokeOpacity = 0; ma.highlightFillOpacity = 0; }
          }
          g = b.create('midpoint', [P(o.points[0]), P(o.points[1])], ma); break;
        }
        case 'circle':
          g = o.through != null
            ? b.create('circle', [P(o.center), P(o.through)], A({ withLabel: false }))
            : b.create('circle', [P(o.center), o.r], A({ withLabel: false })); break;
        case 'arc':   // 圆弧（只画弧线，不填充、无半径线）：center + 起点 + 终点
          g = b.create('arc', [P(o.center), P(o.start), P(o.end)],
            { strokeColor: (o.style && o.style.color) || BLK, strokeWidth: (o.style && o.style.width) || 1.5,
              fillOpacity: 0, withLabel: false, highlight: false,
              lastArrow: o.arrow ? { type: 2, size: 6 } : false }); break;
        case 'circumcircle':
          g = b.create('circumcircle', o.points.map(P),
            { strokeColor: (o.style && o.style.color) || BLK, strokeWidth: 2, withLabel: false }); break;
        case 'perpendicular':
          g = b.create('perpendicular', [P(o.line), P(o.point)], A({ withLabel: false })); break;
        case 'parallel':
          g = b.create('parallel', [P(o.line), P(o.point)], A({ withLabel: false })); break;
        case 'anglebisector':
          g = b.create('bisector', [P(o.points[0]), P(o.points[1]), P(o.points[2])], A({ withLabel: false })); break;
        case 'intersection': {
          var ia = A({ size: 2.5 });
          ia.strokeColor = POINT; ia.fillColor = POINT; ia.fillOpacity = 1; ia.strokeWidth = 1;
          if (ro && (o.label == null || o.label === '')) { ia.fixed = true; ia.strokeOpacity = 0; ia.fillOpacity = 0; ia.highlightStrokeOpacity = 0; ia.highlightFillOpacity = 0; }
          g = b.create('intersection', [P(o.of[0]), P(o.of[1]), o.which || 0], ia); break;
        }
        case 'angle':
          // 直角→小方块（题面常见，清晰）；非直角→顶点附近标文字（∠ABC 或度数），贴教材习惯、不画圆弧盘。
          // 🔴 注：构件层(figure-builder)的角标注走 angleMark，产 curve+text，不经此 case；此处仅兜低层 DSL 直传的 angle。
          if (o.right) {
            g = b.create('angle', [P(o.points[0]), P(o.points[1]), P(o.points[2])],
              { radius: o.radius || 0.45, type: 'square', fillOpacity: 0, strokeColor: BLK, name: '', highlight: false });
          } else {
            var vtx = P(o.points[1]);
            var aName = (o.points[0] && o.points[1] && o.points[2]) ? ('∠' + o.points[0] + o.points[1] + o.points[2]) : '∠';
            var aTxt = o.label != null && o.label !== '' ? o.label : aName;
            g = b.create('text',
              [function () { return vtx.X() + (o.labelOffsetX != null ? o.labelOffsetX : 0.25); },
               function () { return vtx.Y() + (o.labelOffsetY != null ? o.labelOffsetY : 0.25); },
               aTxt],
              { fontSize: (o.style && o.style.fontSize) || 13, color: BLK, display: 'internal', anchorX: 'left', anchorY: 'middle', fixed: true });
          }
          break;
        case 'glider':
          g = b.create('glider', [o.coords[0], o.coords[1], P(o.on)], A({ size: editable ? 4 : 3 })); break;
        case 'tangent':
          g = b.create('tangent', [P(o.at)], { strokeColor: (o.style && o.style.color) || BLK, strokeWidth: 1.3, withLabel: false }); break;
        case 'functiongraph':
          g = b.create('functiongraph', [exprFn(o.expr), o.from != null ? o.from : -10, o.to != null ? o.to : 10],
            { strokeColor: (o.style && o.style.color) || BLK, strokeWidth: (o.style && o.style.width) || 1.6 }); break;
        case 'curve':
          g = b.create('curve', [o.xs, o.ys],
            { strokeColor: (o.style && o.style.color) || BLK, strokeWidth: (o.style && o.style.width) || 1.4,
              dash: (o.style && o.style.dash) ? 2 : 0, lastArrow: o.arrow ? { type: 2, size: 6 } : false }); break;
        case 'ellipse':
          g = ellipse(b, o.cx, o.cy, o.rx, o.ry, o.part || 'full', o.style); break;
        case 'text':
          g = b.create('text', [o.x, o.y, o.text],
            { fontSize: (o.style && o.style.fontSize) || 13, color: (o.style && o.style.color) || BLK, display: 'internal',
              anchorX: o.anchorX || 'left', anchorY: o.anchorY || 'middle' }); break;
        case 'axisArrow':
          g = b.create('line', [o.from, o.to],
            { straightFirst: false, straightLast: false, lastArrow: { type: 2, size: 6 }, strokeColor: BLK, strokeWidth: 1.2 }); break;
        case 'bar':
          g = b.create('polygon', [[o.x0, 0], [o.x1, 0], [o.x1, o.h], [o.x0, o.h]],
            { fillColor: (o.style && o.style.fill) || '#d9d9d9', fillOpacity: 1,
              borders: { strokeColor: BLK, strokeWidth: 1 }, vertices: { visible: false }, withLabel: false }); break;
        case 'sector': {
          var O = b.create('point', [o.cx || 0, o.cy || 0], { visible: false });
          var cp = function (ang) { return b.create('point', [(o.cx || 0) + (o.r || 1) * Math.cos(deg(ang)), (o.cy || 0) + (o.r || 1) * Math.sin(deg(ang))], { visible: false }); };
          g = b.create('sector', [O, cp(o.start), cp(o.end)],
            { fillColor: (o.style && o.style.fill) || '#fff', fillOpacity: (o.style && o.style.fillOpacity) || 0,
              strokeColor: BLK, strokeWidth: 1.2 });
          break;
        }
        case 'numberline':
          g = b.create('line', [[o.xmin, 0], [o.xmax, 0]],
            { straightFirst: false, straightLast: false, lastArrow: { type: 2, size: 6 }, strokeColor: BLK, strokeWidth: 1.2 });
          (o.ticks || []).forEach(function (t) {
            b.create('segment', [[t, -0.12], [t, 0.12]], { strokeColor: BLK, strokeWidth: 1 });
            b.create('text', [t, -0.6, String(t)], { fontSize: 12, anchorX: 'middle', color: BLK, display: 'internal' });
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

  // 真 3D（JSXGraph View3D，可旋转）
  function build3d(b, s3) {
    var view = b.create('view3d',
      [s3.anchor || [-3.5, -3.5], s3.size || [7, 7], s3.range || [[-1.5, 1.5], [-1.5, 1.5], [-1.5, 1.5]]],
      { projection: s3.projection || 'parallel', trackball: { enabled: true } });
    var P = (s3.vertices || []).map(function (v) { return view.create('point3d', v, { withLabel: false, size: 2, fixed: true }); });
    (s3.edges || []).forEach(function (e) { view.create('line3d', [P[e[0]], P[e[1]]], { strokeColor: BLK, strokeWidth: 1.4 }); });
    return view;
  }

  var GeoEngine = {
    /** 在容器里渲染一份 DSL，返回 { board, reg }。
     *  spec 可以是低层几何 DSL，也可以是高层「构件 DSL」（含 build:[...]）——后者自动经 FigureBuilder 展开。
     *  opts.editable=true → 几何点可拖（编辑模式，红点高亮）；spec.readonly / opts.readonly=true → 只读（藏顶点圆点）。 */
    render: function (containerId, spec, opts) {
      spec = spec || {}; opts = opts || {};
      var readonly = spec.readonly || opts.readonly, label0 = spec.label;
      var editable = opts.editable === true;
      if (spec.build && root.FigureBuilder) { spec = root.FigureBuilder.expand(spec); }
      if (readonly) spec.readonly = true;              // 展开器重建 spec，把只读标志带回
      if (label0 && spec.label) spec.label = Object.assign({}, spec.label, label0);
      var board = JXG.JSXGraph.initBoard(containerId, {
        boundingbox: spec.bbox || [-5, 5, 6, -3],
        axis: spec.axis || false, grid: spec.grid || false,
        showCopyright: false, showNavigation: spec.nav || false,
        keepaspectratio: spec.keepAspect !== false,
        pan: { enabled: editable || spec.pan === true, needShift: false },
        zoom: { enabled: editable || spec.zoom === true, wheel: editable || spec.zoom === true }
      });
      var reg = { obj: {}, exp: {} };
      board.suspendUpdate();   // 建完再一次性 update，让 autoPosition 在全部元素就位后算，避让才准
      if (spec.solid3d) { build3d(board, spec.solid3d); }
      buildObjects(board, spec.objects, reg, spec.exportable !== false, spec.label, spec.readonly, editable);
      board.unsuspendUpdate();
      board.fullUpdate();      // 触发标签 setAutoPosition：此时所有线/点已在，冲突数才算得对
      return { board: board, reg: reg };
    },

    /** 重新跑标签避让（拖动元素后手动校位）。 */
    relabel: function (board) { if (board) board.fullUpdate(); },

    /** 导出拖动后的几何状态（存 blockJson）。 */
    exportState: function (reg) {
      var out = {};
      Object.keys(reg.exp || {}).forEach(function (id) { out[id] = reg.exp[id](); });
      return out;
    },

    /** 导出当前画板 SVG 字符串（headless 出图直接写文件）。 */
    exportSVG: function (board) {
      return new XMLSerializer().serializeToString(board.renderer.svgRoot);
    },

    /** 导出 PNG dataURL（客户端出图，可上 OSS 当题图）。 */
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
