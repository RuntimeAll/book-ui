/*!
 * figure-builder.js — 高层「构件 DSL」→ 低层几何 DSL 的确定性展开器
 *
 * 解决「agent 盲打坐标」：agent 只出语义意图（直角三角形/直角在C/两直角边3和4），
 * 本展开器用代码精确解出顶点坐标 —— 几何不变量（∠=90°、等边、共圆）由代码保证，不靠 LLM 心算。
 * 顺带接管 auto-bbox（自动取景，图不出界不过小）。低层 DSL 仍由 geo-render.js 渲染（含标签避让）。
 *
 * 用法：
 *   var low = FigureBuilder.expand(highSpec);   // -> { bbox, axis, objects, ... }（低层 DSL）
 *   GeoEngine.render('box', low);
 *
 * 高层 spec：
 *   { "build": [ <构件项>... ], "axis"?:bool, "fit"?:true, "labelPolicy"?:"auto" }
 * 构件项三种：
 *   ① 基础图形 { id, shape:"triangle|quad|regular|circle|function", kind, ...参数, labels?, at?, rotate? }
 *   ② 复合     { add:"median|midpoint|diagonal|circumcircle|incircle|altitude", of:"<图形id>", ... }
 *   ③ 标注     { mark:"rightangle|angle", of:"<图形id>", at:"<顶点字母>", label? }
 */
(function (root) {
  'use strict';

  var R3 = Math.sqrt(3);
  function rad(d) { return d * Math.PI / 180; }
  function rnd(n) { return Math.round(n * 1e4) / 1e4; }
  function dist(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1]); }

  // ---- 构造上下文：累积低层 objects + 记录每个图形的顶点环，供 add/mark 引用 ----
  function Ctx() { this.objects = []; this.figures = {}; this.pointXY = {}; this.k = 0; this.needAxis = false; this.noAspect = false; this.cover = []; }
  // 让 auto-bbox 把某个矩形范围也算进去（圆/椭圆/立体等没有顶点点的图元用）
  Ctx.prototype.coverBox = function (x, y, rx, ry) { ry = ry == null ? rx : ry; this.cover.push([x - rx, y - ry], [x + rx, y + ry]); };
  Ctx.prototype.uid = function (p) { return (p || 'g') + (++this.k); };
  // 放一个带标签的顶点点；pid 全局唯一，label 显示字母
  Ctx.prototype.vertex = function (figId, label, x, y, opt) {
    var pid = figId + '_' + label;
    this.objects.push(Object.assign({ id: pid, type: 'point', coords: [rnd(x), rnd(y)], label: label }, opt || {}));
    this.pointXY[pid] = [x, y];
    return pid;
  };
  Ctx.prototype.freePoint = function (x, y, label) {  // 无字母的辅助点（如中点/垂足，给 label 才显示）
    var pid = this.uid('p');
    var o = { id: pid, type: 'point', coords: [rnd(x), rnd(y)] };
    if (label) o.label = label;
    this.objects.push(o); this.pointXY[pid] = [x, y]; return pid;
  };
  Ctx.prototype.node = function (x, y) {  // 隐藏顶点（只作连线端点，不画圆点）—— 立体/网格用
    var pid = this.uid('n'); this.objects.push({ id: pid, type: 'point', coords: [rnd(x), rnd(y)], hidden: true }); this.pointXY[pid] = [x, y]; return pid;
  };
  Ctx.prototype.seg = function (a, b, style) { this.objects.push({ id: this.uid('s'), type: 'segment', points: [a, b], style: style }); };
  Ctx.prototype.poly = function (ids) { this.objects.push({ id: this.uid('poly'), type: 'polygon', points: ids }); };
  Ctx.prototype.push = function (o) { o.id = o.id || this.uid('o'); this.objects.push(o); return o.id; };

  // 顶点标签朝「外」放（避开角弧/直角方块/内部）：沿内角平分线反方向偏移，确定性、不靠 autoPosition 瞎猜
  function outwardOffset(pts, i, cen) {
    var n = pts.length, cur = pts[i], pv = pts[(i - 1 + n) % n], nx = pts[(i + 1) % n];
    function u(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1], m = Math.hypot(dx, dy) || 1; return [dx / m, dy / m]; }
    var v1 = u(pv, cur), v2 = u(nx, cur), bis = [v1[0] + v2[0], v1[1] + v2[1]], out;
    if (Math.hypot(bis[0], bis[1]) < 1e-6) out = u(cur, cen);          // 平角：取远离中心方向
    else { out = [-bis[0], -bis[1]]; var m = Math.hypot(out[0], out[1]); out = [out[0] / m, out[1] / m];
      if (out[0] * (cur[0] - cen[0]) + out[1] * (cur[1] - cen[1]) < 0) out = [-out[0], -out[1]]; }  // 保证朝外
    var PX = 15;
    return [rnd(out[0] * PX), rnd(out[1] * PX)];
  }

  // 注册一个多边形图形（三角形/四边形/正多边形通用）：建顶点 + 边 + 记录环
  function polygonFigure(ctx, figId, pts, labels, closed) {
    var cx = 0, cy = 0; pts.forEach(function (p) { cx += p[0]; cy += p[1]; }); cx /= pts.length; cy /= pts.length;
    var ids = pts.map(function (p, i) {
      return ctx.vertex(figId, labels[i], p[0], p[1], { vx: true, autoLabel: false, style: { labelOffset: outwardOffset(pts, i, [cx, cy]) } });
    });
    ctx.poly(ids);
    ctx.figures[figId] = { kind: 'polygon', labels: labels, ids: ids, xy: pts.slice() };
    return ids;
  }

  /* ===================== 三角形族 ===================== */
  function triangle(ctx, it) {
    var L = it.labels || ['A', 'B', 'C'], k = it.kind || 'sss', P;
    if (k === 'equilateral') {
      var s = it.side || 4; P = [[0, 0], [s, 0], [s / 2, s * R3 / 2]];
    } else if (k === 'isosceles') {
      var base = it.base || 4, h = it.height != null ? it.height : Math.sqrt((it.leg || 4) * (it.leg || 4) - base * base / 4);
      P = [[0, 0], [base, 0], [base / 2, h]];
    } else if (k === 'right') {
      var lg = it.legs || [3, 4], rA = it.rightAt || L[2];
      // 直角顶点在原点，两直角边沿 +x/+y；其余两顶点按 label 顺序填轴
      var others = L.filter(function (x) { return x !== rA; });
      var pos = {}; pos[rA] = [0, 0]; pos[others[0]] = [lg[0], 0]; pos[others[1]] = [0, lg[1]];
      P = L.map(function (x) { return pos[x]; });
    } else if (k === 'rightIsosceles') {
      var lg2 = it.leg || 3, rA2 = it.rightAt || L[2];
      var o2 = L.filter(function (x) { return x !== rA2; });
      var ps = {}; ps[rA2] = [0, 0]; ps[o2[0]] = [lg2, 0]; ps[o2[1]] = [0, lg2];
      P = L.map(function (x) { return ps[x]; });
    } else if (k === 'sas') {     // 两边夹角：A 为夹角顶点
      var s1 = it.side1 || 4, ang = it.angle || 60, s2 = it.side2 || 4;
      P = [[0, 0], [s1, 0], [s2 * Math.cos(rad(ang)), s2 * Math.sin(rad(ang))]];
    } else {                      // sss：边 a=BC,b=CA,c=AB（a 对 A）
      var sd = it.sides || [5, 4, 3], a = sd[0], b = sd[1], c = sd[2];
      if (a + b <= c || a + c <= b || b + c <= a) throw new Error('三角形三边不满足两边之和大于第三边: ' + sd);
      var x = (c * c - b * b + a * a) / (2 * a), y = Math.sqrt(Math.max(0, c * c - x * x));
      P = [[x, y], [0, 0], [a, 0]];  // A=(x,y), B=(0,0), C=(a,0)
    }
    P = applyPlacement(P, it);
    polygonFigure(ctx, it.id || ctx.uid('tri'), P, L, true);
  }

  /* ===================== 四边形族 ===================== */
  function quad(ctx, it) {
    var L = it.labels || ['A', 'B', 'C', 'D'], k = it.kind || 'square', P;
    if (k === 'square') { var s = it.side || 4; P = [[0, 0], [s, 0], [s, s], [0, s]]; }
    else if (k === 'rectangle') { var w = it.width || 5, h = it.height || 3; P = [[0, 0], [w, 0], [w, h], [0, h]]; }
    else if (k === 'parallelogram') {
      var b = it.base || 5, sd = it.side || 3, an = rad(it.angle || 60);
      P = [[0, 0], [b, 0], [b + sd * Math.cos(an), sd * Math.sin(an)], [sd * Math.cos(an), sd * Math.sin(an)]];
    } else if (k === 'rhombus') {
      var ss = it.side || 4, ra = rad(it.angle || 60);
      P = [[0, 0], [ss, 0], [ss + ss * Math.cos(ra), ss * Math.sin(ra)], [ss * Math.cos(ra), ss * Math.sin(ra)]];
    } else if (k === 'trapezoid') {
      var bot = it.bottom || 6, top = it.top || 3, th = it.height || 3;
      if (it.right) { P = [[0, 0], [bot, 0], [top, th], [0, th]]; }        // 直角梯形（左边竖直）
      else { var off = (bot - top) / 2; P = [[0, 0], [bot, 0], [off + top, th], [off, th]]; } // 等腰梯形
    } else throw new Error('未知四边形 kind: ' + k);
    P = applyPlacement(P, it);
    polygonFigure(ctx, it.id || ctx.uid('quad'), P, L, true);
  }

  /* ===================== 正多边形 ===================== */
  function regular(ctx, it) {
    var n = it.n || 6;
    var r = it.r != null ? it.r : (it.side || 3) / (2 * Math.sin(Math.PI / n));
    var rot = rad(it.rotate != null ? it.rotate : 90 + (n % 2 ? 0 : 180 / n)); // 默认底边水平
    var L = it.labels || defaultLetters(n);
    var P = [];
    for (var i = 0; i < n; i++) { var t = rot + i * 2 * Math.PI / n; P.push([r * Math.cos(t), r * Math.sin(t)]); }
    P = applyPlacement(P, it);
    polygonFigure(ctx, it.id || ctx.uid('reg'), P, L, true);
  }

  /* ===================== 圆族 ===================== */
  function circle(ctx, it) {
    var k = it.kind || 'plain', c = it.center || [0, 0], r = it.r || 3, figId = it.id || ctx.uid('cir');
    if (k === 'plain') {
      var O = ctx.vertex(figId, it.centerLabel || 'O', c[0], c[1], { keepDot: true, size: 2 });
      ctx.push({ type: 'circle', center: O, r: r }); ctx.coverBox(c[0], c[1], r);
      ctx.figures[figId] = { kind: 'circle', center: O, r: r, c: c };
    } else if (k === 'sector') {
      var O2 = ctx.vertex(figId, it.centerLabel || 'O', c[0], c[1], { keepDot: true, size: 2 });
      var sA = it.start || 0, eA = it.end || 90;
      var p1 = ctx.freePoint(c[0] + r * Math.cos(rad(sA)), c[1] + r * Math.sin(rad(sA)));
      var p2 = ctx.freePoint(c[0] + r * Math.cos(rad(eA)), c[1] + r * Math.sin(rad(eA)));
      ctx.push({ type: 'sector', cx: c[0], cy: c[1], r: r, start: sA, end: eA });
      ctx.seg(O2, p1); ctx.seg(O2, p2); ctx.coverBox(c[0], c[1], r);
    } else if (k === 'tangent') {     // 圆 + 切点P + 半径OP + 切线 + 直角
      var O3 = ctx.vertex(figId, it.centerLabel || 'O', c[0], c[1], { keepDot: true, size: 2 });
      ctx.push({ type: 'circle', center: O3, r: r }); ctx.coverBox(c[0], c[1], r);
      var ta = rad(it.atAngle != null ? it.atAngle : 60);
      var Px = c[0] + r * Math.cos(ta), Py = c[1] + r * Math.sin(ta);
      var Pp = ctx.vertex(figId, it.pointLabel || 'P', Px, Py);
      ctx.seg(O3, Pp);
      // 切线方向 = 垂直 OP，过 P 两侧各延 r*0.9
      var tx = -Math.sin(ta), ty = Math.cos(ta), Ln = r * 0.95;
      var t1xy = [Px + tx * Ln, Py + ty * Ln], t2xy = [Px - tx * Ln, Py - ty * Ln];
      ctx.seg(ctx.node(t1xy[0], t1xy[1]), ctx.node(t2xy[0], t2xy[1]));
      angleMark(ctx, [Px, Py], c, t1xy, { right: true, radius: 0.32 });
      ctx.figures[figId] = { kind: 'circle', center: O3, r: r, c: c };
    } else throw new Error('未知圆 kind: ' + k);
  }

  // 圆弧（圆心→起点→终点），只画弧线；三个点都显示为实心点
  function arcShape(ctx, it) {
    var c = it.center || [0, 0], r = it.r || 3, s = it.start != null ? it.start : 30, e = it.end != null ? it.end : 130;
    var L = it.labels || ['O', 'A', 'B'], figId = it.id || ctx.uid('arc');
    var O = ctx.vertex(figId, L[0], c[0], c[1], { keepDot: true });
    var P1 = ctx.vertex(figId, L[1], c[0] + r * Math.cos(rad(s)), c[1] + r * Math.sin(rad(s)), { keepDot: true });
    var P2 = ctx.vertex(figId, L[2], c[0] + r * Math.cos(rad(e)), c[1] + r * Math.sin(rad(e)), { keepDot: true });
    if (it.radii) { ctx.seg(O, P1); ctx.seg(O, P2); }          // 需要半径线时才画
    ctx.push({ type: 'arc', center: O, start: P1, end: P2 });
    ctx.coverBox(c[0], c[1], r);
  }

  /* ===================== 坐标系 / 函数 ===================== */
  function func(ctx, it) {
    ctx.needAxis = true;
    var k = it.kind || 'linear', expr, from = it.from != null ? it.from : -6, to = it.to != null ? it.to : 6;
    if (k === 'linear') { var kk = it.k != null ? it.k : 1, bb = it.b != null ? it.b : 0; expr = kk + '*x+' + bb; }
    else if (k === 'quadratic') {
      var a = it.a != null ? it.a : 1, b = it.b != null ? it.b : 0, c = it.c != null ? it.c : 0;
      expr = a + '*x^2+' + b + '*x+' + c;
      var vx = -b / (2 * a), vy = c - b * b / (4 * a);
      ctx.objects.push({ id: ctx.uid('p'), type: 'point', coords: [rnd(vx), rnd(vy)], label: it.vertexLabel || '顶点' });
    } else if (k === 'inverse') {     // y=k/x，两支
      var ik = it.k != null ? it.k : 4;
      ctx.push({ type: 'functiongraph', expr: ik + '/x', from: 0.3, to: to });
      ctx.push({ type: 'functiongraph', expr: ik + '/x', from: from, to: -0.3 });
      ctx.figures[it.id || ctx.uid('fn')] = { kind: 'function' };
      return;
    } else throw new Error('未知函数 kind: ' + k);
    ctx.push({ type: 'functiongraph', expr: expr, from: from, to: to });
    ctx.figures[it.id || ctx.uid('fn')] = { kind: 'function' };
  }

  /* ===================== add / mark 复合算子 ===================== */
  function vIndex(fig, letter) { return fig.labels.indexOf(letter); }
  function vXY(fig, letter) { return fig.xy[vIndex(fig, letter)]; }
  function vID(fig, letter) { return fig.ids[vIndex(fig, letter)]; }

  function addOp(ctx, it) {
    var fig = ctx.figures[it.of];
    if (!fig) throw new Error('add 引用了不存在的图形: ' + it.of);
    if (it.add === 'midpoint') {
      var e = it.edge || (fig.labels[0] + fig.labels[1]);
      ctx.push({ type: 'midpoint', points: [vID(fig, e[0]), vID(fig, e[1])], label: it.label });
    } else if (it.add === 'median') {        // 三角形：from 顶点 → 对边中点
      var v = it.from || fig.labels[0], opp = fig.labels.filter(function (x) { return x !== v; });
      var mid = ctx.push({ type: 'midpoint', points: [vID(fig, opp[0]), vID(fig, opp[1])], label: it.label });
      ctx.seg(vID(fig, v), mid);
    } else if (it.add === 'altitude') {      // 三角形：from 顶点 → 对边的垂足
      var av = it.from || fig.labels[0], oo = fig.labels.filter(function (x) { return x !== av; });
      var A = vXY(fig, av), B = vXY(fig, oo[0]), C = vXY(fig, oo[1]);
      var foot = projectFoot(A, B, C);
      var fid = ctx.freePoint(foot[0], foot[1], it.footLabel);
      ctx.seg(vID(fig, av), fid, { dash: it.dash !== false });
      angleMark(ctx, foot, B, A, { right: true, radius: 0.3 });   // 垂足直角
    } else if (it.add === 'diagonal') {      // 四边形：两条对角线；center:true 则在交点画实心点
      var lb = fig.labels;
      ctx.seg(vID(fig, lb[0]), vID(fig, lb[2]));
      ctx.seg(vID(fig, lb[1]), vID(fig, lb[3]));
      if (it.center) {
        var xp = lineIntersect(vXY(fig, lb[0]), vXY(fig, lb[2]), vXY(fig, lb[1]), vXY(fig, lb[3]));
        if (xp) ctx.objects.push({ id: ctx.uid('p'), type: 'point', coords: [rnd(xp[0]), rnd(xp[1])], label: it.centerLabel || 'O', keepDot: true });
      }
    } else if (it.add === 'intersection') {  // 通用交点：两条边(如 "AC" 与 "BD")的交点画实心点
      var s1 = it.of1 || it.edges && it.edges[0], s2 = it.of2 || it.edges && it.edges[1];
      var xi = lineIntersect(vXY(fig, s1[0]), vXY(fig, s1[1]), vXY(fig, s2[0]), vXY(fig, s2[1]));
      if (xi) ctx.objects.push({ id: ctx.uid('p'), type: 'point', coords: [rnd(xi[0]), rnd(xi[1])], label: it.label || 'O', keepDot: true });
    } else if (it.add === 'centroid') {      // 三角形重心（中线交点）实心点
      var g = fig.xy, gx = (g[0][0] + g[1][0] + g[2][0]) / 3, gy = (g[0][1] + g[1][1] + g[2][1]) / 3;
      ctx.objects.push({ id: ctx.uid('p'), type: 'point', coords: [rnd(gx), rnd(gy)], label: it.label || 'G', keepDot: true });
    } else if (it.add === 'circumcircle') {  // 三角形外接圆（低层精确算；这里另算圆心半径供取景）
      ctx.push({ type: 'circumcircle', points: fig.ids.slice(0, 3) });
      var cc = circumcenter(fig.xy[0], fig.xy[1], fig.xy[2]);
      if (cc) ctx.coverBox(cc[0], cc[1], cc[2]);
    } else if (it.add === 'incircle') {      // 三角形内切圆：JS 精确算内心+内切半径
      var p = fig.xy, a = dist(p[1], p[2]), b = dist(p[2], p[0]), c = dist(p[0], p[1]), per = a + b + c;
      var ix = (a * p[0][0] + b * p[1][0] + c * p[2][0]) / per, iy = (a * p[0][1] + b * p[1][1] + c * p[2][1]) / per;
      var area = Math.abs((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])) / 2;
      ctx.push({ type: 'circleOutline', cx: rnd(ix), cy: rnd(iy), r: rnd(2 * area / per) });
    } else throw new Error('未知 add: ' + it.add);
  }

  function angleDeg(A, V, B) {   // ∠AVB 度数
    var u = [A[0] - V[0], A[1] - V[1]], w = [B[0] - V[0], B[1] - V[1]];
    var d = (u[0] * w[0] + u[1] * w[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(w[0], w[1]) || 1);
    return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
  }
  // 🔴 自己画角标记（不用 JSXGraph angle 元件，杜绝填充扇形/画反侧）：
  //    V=顶点, P1/P2=两条边上的点。取「短弧=非优角」侧（凸多边形内角天然是它）。
  var DEG_COLOR = '#1a73e8';
  function angleMark(ctx, V, P1, P2, opt) {
    opt = opt || {};
    var t1 = Math.atan2(P1[1] - V[1], P1[0] - V[0]), t2 = Math.atan2(P2[1] - V[1], P2[0] - V[0]);
    var d = t2 - t1; while (d <= -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI;  // 归一化到(-π,π]=短弧
    var eMin = Math.min(dist(V, P1), dist(V, P2));
    // 🔴 角弧半径固定（不随邻边飘）：直角方块 0.3、度数弧 0.42。
    //    只在邻边过短时按 eMin*0.4 缩小（防吞小图），正常图形恒为固定值、永不放大。
    var ARC_R = 0.42, RIGHT_R = 0.3;
    var rBase = opt.right ? RIGHT_R : ARC_R;
    var r = opt.radius != null ? opt.radius : Math.min(rBase, eMin * 0.4);
    var c = Math.cos, s = Math.sin;
    if (opt.right) {                 // 直角小方块（两条边）
      var a1 = ctx.node(V[0] + r * c(t1), V[1] + r * s(t1));
      var cr = ctx.node(V[0] + r * c(t1) + r * c(t2), V[1] + r * s(t1) + r * s(t2));
      var a2 = ctx.node(V[0] + r * c(t2), V[1] + r * s(t2));
      ctx.seg(a1, cr); ctx.seg(cr, a2);
    } else {                         // 小弧线（采样成 curve，永远走短弧=内角侧）
      var N = 18, xs = [], ys = [];
      for (var i = 0; i <= N; i++) { var t = t1 + d * i / N; xs.push(rnd(V[0] + r * c(t))); ys.push(rnd(V[1] + r * s(t))); }
      ctx.push({ type: 'curve', xs: xs, ys: ys, style: { color: '#333', width: 1.3 } });
    }
    if (opt.label != null && opt.label !== '') {   // 度数/标签放在角平分线方向、弧外一点
      var mid = t1 + d / 2, lr = r + 0.55;
      ctx.objects.push({ id: ctx.uid('t'), type: 'text', x: rnd(V[0] + lr * c(mid)), y: rnd(V[1] + lr * s(mid)),
        text: String(opt.label), anchorX: 'middle', style: { color: DEG_COLOR, fontSize: 13 } });
    }
  }
  function markOp(ctx, it) {
    var fig = ctx.figures[it.of];
    if (!fig) throw new Error('mark 引用了不存在的图形: ' + it.of);
    var at = it.at, idx = vIndex(fig, at), n = fig.labels.length;
    var prev = fig.labels[(idx - 1 + n) % n], next = fig.labels[(idx + 1) % n];
    var pAt = vXY(fig, at), pPrev = vXY(fig, prev), pNext = vXY(fig, next);
    var label = it.label;
    if (it.showDegrees) label = Math.round(angleDeg(pPrev, pAt, pNext)) + '°';
    angleMark(ctx, pAt, pPrev, pNext, { right: it.mark === 'rightangle', label: label, radius: it.radius });
  }

  /* ===================== 小学专项（钟面/分数条/分数饼/方格面积）===================== */
  function clock(ctx, it) {
    var r = 3, hour = it.hour != null ? it.hour : 3, minute = it.minute || 0;
    var O = ctx.vertex('clk', '', 0, 0, { hidden: false, size: 2 });
    ctx.push({ type: 'circle', center: O, r: r }); ctx.coverBox(0, 0, r + 0.4);
    for (var k = 1; k <= 12; k++) {
      var a = rad(90 - k * 30);
      ctx.seg(ctx.node(r * 0.9 * Math.cos(a), r * 0.9 * Math.sin(a)), ctx.node(r * Math.cos(a), r * Math.sin(a)));
      txt(ctx, r * 0.76 * Math.cos(a), r * 0.76 * Math.sin(a), k);
    }
    var hA = rad(90 - (hour % 12 + minute / 60) * 30), mA = rad(90 - minute * 6);
    ctx.seg(O, ctx.node(1.6 * Math.cos(hA), 1.6 * Math.sin(hA)), { width: 2.4 });   // 时针短粗
    ctx.seg(O, ctx.node(2.4 * Math.cos(mA), 2.4 * Math.sin(mA)), { width: 1.4 });   // 分针长细
  }

  function fractionBar(ctx, it) {
    ctx.noAspect = true;
    var n = it.parts || 4, W = 6, H = 1.2, cw = W / n;
    var shaded = it.shadedList || (function () { var a = []; for (var i = 0; i < (it.shaded || 0); i++) a.push(i); return a; })();
    shaded.forEach(function (i) { ctx.push({ type: 'bar', x0: i * cw, x1: (i + 1) * cw, h: H, style: { fill: it.color || '#9AD0F5' } }); });
    // 外框 + 内部等分竖线
    ctx.seg(ctx.node(0, 0), ctx.node(W, 0)); ctx.seg(ctx.node(W, 0), ctx.node(W, H));
    ctx.seg(ctx.node(W, H), ctx.node(0, H)); ctx.seg(ctx.node(0, H), ctx.node(0, 0));
    for (var j = 1; j < n; j++) ctx.seg(ctx.node(j * cw, 0), ctx.node(j * cw, H));
    if (it.showFraction !== false) txt(ctx, W / 2, -0.5, shaded.length + '/' + n);
    ctx.coverBox(W / 2, H / 2, W / 2 + 0.3, H / 2 + 0.6);
  }

  function fractionCircle(ctx, it) {
    var n = it.parts || 4, r = it.r || 2.6;
    var shaded = it.shadedList || (function () { var a = []; for (var i = 0; i < (it.shaded || 0); i++) a.push(i); return a; })();
    ctx.push({ type: 'circleOutline', cx: 0, cy: 0, r: r });
    for (var i = 0; i < n; i++) {
      var a0 = 90 - (i + 1) * 360 / n, a1 = 90 - i * 360 / n;   // 顺时针等分
      if (shaded.indexOf(i) >= 0) ctx.push({ type: 'sector', cx: 0, cy: 0, r: r, start: a0, end: a1, style: { fill: it.color || '#9AD0F5', fillOpacity: 0.7 } });
      else ctx.push({ type: 'sector', cx: 0, cy: 0, r: r, start: a0, end: a1 });
    }
    if (it.showFraction !== false) txt(ctx, 0, -r - 0.5, shaded.length + '/' + n);
    ctx.coverBox(0, 0, r + 0.3, r + 0.7);
  }

  function gridArea(ctx, it) {
    var cols = it.cols || 6, rows = it.rows || 6;
    var gs = { color: '#ccc', width: 0.6 };
    for (var x = 0; x <= cols; x++) ctx.seg(ctx.node(x, 0), ctx.node(x, rows), gs);
    for (var y = 0; y <= rows; y++) ctx.seg(ctx.node(0, y), ctx.node(cols, y), gs);
    (it.shadeCells || []).forEach(function (c) {   // c=[col,row] 左下角
      ctx.push({ type: 'bar', x0: c[0], x1: c[0] + 1, h: 0, style: {} });   // 占位，真填充下面用 polygon
    });
    // 上一行 bar 高度为 0 无效，改用 polygon 填充格子
    ctx.objects = ctx.objects.filter(function (o) { return !(o.type === 'bar' && o.h === 0); });
    (it.shadeCells || []).forEach(function (c) {
      var a = ctx.node(c[0], c[1]), b = ctx.node(c[0] + 1, c[1]), d2 = ctx.node(c[0] + 1, c[1] + 1), e = ctx.node(c[0], c[1] + 1);
      ctx.objects.push({ id: ctx.uid('poly'), type: 'polygon', points: [a, b, d2, e], style: { color: it.color || '#9AD0F5', fillOpacity: 0.6 } });
    });
    if (it.lattice) {   // 格点上的多边形（顶点=格点坐标 [[x,y]...]）
      var ids = it.lattice.map(function (p) { return ctx.node(p[0], p[1]); });
      ctx.objects.push({ id: ctx.uid('poly'), type: 'polygon', points: ids, style: { color: '#e11', fillOpacity: 0.12 } });
    }
    ctx.coverBox(cols / 2, rows / 2, cols / 2 + 0.5, rows / 2 + 0.5);
  }

  /* ===================== 基础与角（数轴/角/三线八角/坐标描点）===================== */
  function numberLine(ctx, it) {
    ctx.noAspect = true;
    var min = it.min != null ? it.min : -5, max = it.max != null ? it.max : 5;
    var ticks = it.ticks || (function () { var a = []; for (var i = Math.ceil(min); i <= Math.floor(max); i++) a.push(i); return a; })();
    ctx.push({ type: 'numberline', xmin: min, xmax: max, ticks: ticks });
    function dot(x, open, label) {
      ctx.objects.push({ id: ctx.uid('p'), type: 'point', coords: [x, 0], label: label, keepDot: true, style: open ? { color: '#e11', fill: '#fff', size: 4 } : { color: '#e11', fill: '#e11', size: 4 } });
    }
    (it.points || []).forEach(function (p) { dot(p.x, p.open, p.label); });
    (it.intervals || []).forEach(function (iv) {
      var a = iv.from != null ? iv.from : min, b = iv.to != null ? iv.to : max;
      ctx.seg(ctx.node(a, 0), ctx.node(b, 0), { color: '#e11', width: 3 });
      if (iv.from != null) dot(a, iv.fromOpen);
      if (iv.to != null) dot(b, iv.toOpen);
    });
    ctx.coverBox((min + max) / 2, 0, (max - min) / 2 + 0.5, 1.2);
  }

  function angleShape(ctx, it) {
    var deg = it.degrees != null ? it.degrees : 60, rayLen = it.rayLen || 3.4, L = it.labels || ['A', 'O', 'B'];
    var figId = it.id || ctx.uid('ang');
    var O = ctx.vertex(figId, L[1], 0, 0, { vx: true });
    var A = ctx.vertex(figId, L[0], rayLen, 0, { vx: true });
    var Bp = ctx.vertex(figId, L[2], rayLen * Math.cos(rad(deg)), rayLen * Math.sin(rad(deg)), { vx: true });
    ctx.seg(O, A); ctx.seg(O, Bp);
    var Axy = [rayLen, 0], Bxy = [rayLen * Math.cos(rad(deg)), rayLen * Math.sin(rad(deg))];
    angleMark(ctx, [0, 0], Axy, Bxy, { right: Math.abs(deg - 90) < 1e-6 && it.markRight !== false, label: it.showDegrees ? deg + '°' : it.label, radius: it.radius });
    ctx.figures[figId] = { kind: 'polygon', labels: [L[0], L[1], L[2]], ids: [A, O, Bp], xy: [Axy, [0, 0], Bxy] };
  }

  function parallelCut(ctx, it) {   // 三线八角：两平行线 + 一条截线
    var gap = it.gap || 3, ang = it.angle || 55, half = it.half || 4.2;
    var slope = Math.tan(rad(ang));
    var l1a = ctx.node(-half, 0), l1b = ctx.node(half, 0), l2a = ctx.node(-half, gap), l2b = ctx.node(half, gap);
    ctx.objects.push({ id: ctx.uid('L'), type: 'line', points: [l1a, l1b] });
    ctx.objects.push({ id: ctx.uid('L'), type: 'line', points: [l2a, l2b] });
    // 截线过 (0,0) 与 (gap/slope, gap)，向两端延伸
    var ext = 1.6, ya = -ext, yb = gap + ext;
    var t1 = ctx.node(ya / slope, ya), t2 = ctx.node(yb / slope, yb);
    ctx.objects.push({ id: ctx.uid('L'), type: 'line', points: [t1, t2] });
    ctx.vertex('pc', it.labels && it.labels[0] || 'O', 0, 0, { size: 2 });
    ctx.vertex('pc', it.labels && it.labels[1] || 'P', gap / slope, gap, { size: 2 });
    ctx.coverBox(0, gap / 2, half + 0.5, gap / 2 + ext + 0.5);
  }

  function coordinate(ctx, it) {
    ctx.needAxis = true;
    var ids = (it.points || []).map(function (p) {
      return ctx.vertex(it.id || 'pt', p.label || '', p.x, p.y, { keepDot: true, size: p.label ? 4 : 3 });
    });
    (it.segments || []).forEach(function (s) { ctx.seg(ids[s[0]], ids[s[1]]); });
    if (it.polygon && ids.length >= 3) ctx.poly(ids);
  }

  /* ===================== 统计图（条形/扇形/折线/直方图）===================== */
  var PALETTE = ['#5B8FF9', '#61DDAA', '#F6BD16', '#F08BB4', '#65789B', '#7262FD', '#78D3F8'];
  function txt(ctx, x, y, s, anchor) { ctx.objects.push({ id: ctx.uid('t'), type: 'text', x: rnd(x), y: rnd(y), text: String(s), anchorX: anchor || 'middle' }); }

  function chart(ctx, it) {
    ctx.noAspect = true;
    var k = it.kind || 'bar';
    if (k === 'bar' || k === 'histogram') bars(ctx, it, k === 'histogram');
    else if (k === 'pie') pie(ctx, it);
    else if (k === 'line') lineChart(ctx, it);
    else throw new Error('未知统计图 kind: ' + k);
  }

  function axes(ctx, W, H) {
    ctx.push({ type: 'axisArrow', from: [0, 0], to: [W, 0] });
    ctx.push({ type: 'axisArrow', from: [0, 0], to: [0, H] });
  }
  function niceStep(maxv) {   // 取「好看」刻度间隔 1/2/5×10^n
    var raw = maxv / 5, mag = Math.pow(10, Math.floor(Math.log10(raw || 1))), n = (raw || 1) / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }
  function yScale(ctx, maxv, W) {   // y 轴刻度线 + 数字 + 淡横向网格
    var step = niceStep(maxv);
    for (var y = step; y <= maxv + 1e-9; y += step) {
      ctx.seg(ctx.node(-0.15, y), ctx.node(0.15, y));                       // 刻度短横
      if (W) ctx.seg(ctx.node(0, y), ctx.node(W, y), { color: '#e5e8ef', width: 0.6 }); // 淡网格
      txt(ctx, -0.4, y, step < 1 ? +y.toFixed(1) : Math.round(y), 'right'); // 数字标在 y 轴左侧
    }
  }

  function bars(ctx, it, hist) {
    var vals = it.values || it.freqs || [], n = vals.length, maxv = Math.max.apply(0, vals) || 1;
    var H = maxv * 1.18;
    if (hist) {
      var edges = it.edges || [], W = (edges[edges.length - 1] || n) * 1.05;
      axes(ctx, W * 1.05, H);
      yScale(ctx, maxv, W);
      for (var i = 0; i < n; i++) {
        ctx.push({ type: 'bar', x0: edges[i], x1: edges[i + 1], h: vals[i], style: { fill: PALETTE[i % PALETTE.length] } });
        txt(ctx, (edges[i] + edges[i + 1]) / 2, vals[i] + maxv * 0.05, vals[i]);
      }
      edges.forEach(function (e) { txt(ctx, e, -maxv * 0.07, e); });
      ctx.coverBox(W / 2, H / 2, W / 2 + 0.5, H / 2 + 0.5);
    } else {
      var cats = it.categories || it.labels || [], bw = it.barWidth || 1, gap = it.gap != null ? it.gap : 0.6;
      var Wd = n * (bw + gap) + gap;
      axes(ctx, Wd, H);
      yScale(ctx, maxv, Wd);
      for (var j = 0; j < n; j++) {
        var x0 = gap + j * (bw + gap), x1 = x0 + bw, cx = (x0 + x1) / 2;
        ctx.push({ type: 'bar', x0: x0, x1: x1, h: vals[j], style: { fill: PALETTE[j % PALETTE.length] } });
        txt(ctx, cx, vals[j] + maxv * 0.05, vals[j]);
        if (cats[j] != null) txt(ctx, cx, -maxv * 0.08, cats[j]);
      }
      ctx.coverBox(Wd / 2, H / 2, Wd / 2 + 0.5, H / 2 + maxv * 0.12 + 0.3);
    }
  }

  function pie(ctx, it) {
    var parts = it.parts || [], total = parts.reduce(function (s, p) { return s + (p.value || 0); }, 0) || 1, r = it.r || 3, acc = 90; // 从正上方起，顺时针
    ctx.push({ type: 'circleOutline', cx: 0, cy: 0, r: r });
    parts.forEach(function (p, i) {
      var sweep = p.value / total * 360, a0 = acc - sweep, a1 = acc;  // 顺时针：角递减
      ctx.push({ type: 'sector', cx: 0, cy: 0, r: r, start: a0, end: a1, style: { fill: p.color || PALETTE[i % PALETTE.length], fillOpacity: 0.55 } });
      var mid = rad((a0 + a1) / 2), pct = Math.round(p.value / total * 100);
      txt(ctx, r * 1.25 * Math.cos(mid), r * 1.25 * Math.sin(mid), (p.label != null ? p.label + ' ' : '') + pct + '%');
      acc = a0;
    });
    ctx.coverBox(0, 0, r * 1.7);
  }

  function lineChart(ctx, it) {
    var cats = it.categories || it.labels || [], vals = it.values || [], n = vals.length;
    var maxv = Math.max.apply(0, vals) || 1, H = maxv * 1.18, W = (n + 1);
    axes(ctx, W, H);
    yScale(ctx, maxv, W);
    var xs = [], ys = [];
    for (var i = 0; i < n; i++) { xs.push(i + 1); ys.push(vals[i]); }
    ctx.push({ type: 'curve', xs: xs, ys: ys, style: { color: PALETTE[0], width: 1.8 } });
    for (var j = 0; j < n; j++) {
      ctx.objects.push({ id: ctx.uid('p'), type: 'point', coords: [j + 1, vals[j]], style: { color: PALETTE[0], size: 3 } });
      txt(ctx, j + 1, vals[j] + maxv * 0.06, vals[j]);
      if (cats[j] != null) txt(ctx, j + 1, -maxv * 0.08, cats[j]);
    }
    ctx.coverBox(W / 2, H / 2, W / 2 + 0.5, H / 2 + maxv * 0.12 + 0.3);
  }

  /* ===================== 立体几何（斜二测投影）===================== */
  // 斜二测：深度方向 45°、长度减半。off = 深度在屏幕上的偏移向量
  function obOff(depth) { var d = depth * 0.5; return [d * Math.cos(Math.PI / 4), d * Math.sin(Math.PI / 4)]; }
  var DASH = { dash: true };

  function solid(ctx, it) {
    var k = it.kind || 'cube';
    if (k === 'cube' || k === 'cuboid' || k === 'box') {
      var l = it.l != null ? it.l : (it.a || 3), h = it.h != null ? it.h : (it.a || 3), w = it.w != null ? it.w : (it.a || 3);
      box(ctx, l, h, w);
    } else if (k === 'cylinder') { cylinder(ctx, it.r || 2, it.h || 4); }
    else if (k === 'cone') { cone(ctx, it.r || 2, it.h || 4); }
    else if (k === 'sphere') { sphere(ctx, it.r || 2.5); }
    else if (k === 'prism') { prism(ctx, it); }
    else if (k === 'pyramid') { pyramid(ctx, it); }
    else throw new Error('未知立体 kind: ' + k);
  }

  function box(ctx, l, h, w) {
    var o = obOff(w), ox = o[0], oy = o[1];
    var F = [[0, 0], [l, 0], [l, h], [0, h]];            // 前面 A B C D
    var Bk = F.map(function (p) { return [p[0] + ox, p[1] + oy]; });
    var f = F.map(function (p) { return ctx.node(p[0], p[1]); });
    var b = Bk.map(function (p) { return ctx.node(p[0], p[1]); });
    // 前面四边（实）
    ctx.seg(f[0], f[1]); ctx.seg(f[1], f[2]); ctx.seg(f[2], f[3]); ctx.seg(f[3], f[0]);
    // 后面：可见 B'C' C'D' 实；隐藏 A'B' A'D' 虚
    ctx.seg(b[0], b[1], DASH); ctx.seg(b[1], b[2]); ctx.seg(b[2], b[3]); ctx.seg(b[3], b[0], DASH);
    // 连接棱：A-A' 虚（后下角隐藏），其余实
    ctx.seg(f[0], b[0], DASH); ctx.seg(f[1], b[1]); ctx.seg(f[2], b[2]); ctx.seg(f[3], b[3]);
    ctx.coverBox((l + ox) / 2, (h + oy) / 2, Math.max(l, h) / 2 + Math.abs(ox));
  }

  function cylinder(ctx, r, h) {
    var ry = r * 0.32;
    // 顶面整椭圆，底面前实后虚
    ctx.objects.push({ id: ctx.uid('e'), type: 'ellipse', cx: 0, cy: h, rx: r, ry: ry, part: 'full' });
    ctx.objects.push({ id: ctx.uid('e'), type: 'ellipse', cx: 0, cy: 0, rx: r, ry: ry, part: 'front' });
    ctx.objects.push({ id: ctx.uid('e'), type: 'ellipse', cx: 0, cy: 0, rx: r, ry: ry, part: 'back' });
    ctx.seg(ctx.node(-r, 0), ctx.node(-r, h)); ctx.seg(ctx.node(r, 0), ctx.node(r, h));  // 两条母线
    ctx.coverBox(0, h / 2, r + 0.2, h / 2 + ry + 0.2);
  }

  function cone(ctx, r, h) {
    var ry = r * 0.32, apex = ctx.node(0, h);
    ctx.objects.push({ id: ctx.uid('e'), type: 'ellipse', cx: 0, cy: 0, rx: r, ry: ry, part: 'front' });
    ctx.objects.push({ id: ctx.uid('e'), type: 'ellipse', cx: 0, cy: 0, rx: r, ry: ry, part: 'back' });
    ctx.seg(apex, ctx.node(-r, 0)); ctx.seg(apex, ctx.node(r, 0));  // 两条母线
    ctx.coverBox(0, h / 2, r + 0.2, h / 2 + ry + 0.2);
  }

  function sphere(ctx, r) {
    var O = ctx.vertex('sph', 'O', 0, 0, { hidden: false, size: 2 });
    ctx.push({ type: 'circle', center: O, r: r });
    ctx.objects.push({ id: ctx.uid('e'), type: 'ellipse', cx: 0, cy: 0, rx: r, ry: r * 0.3, part: 'front' });
    ctx.objects.push({ id: ctx.uid('e'), type: 'ellipse', cx: 0, cy: 0, rx: r, ry: r * 0.3, part: 'back' });
    ctx.coverBox(0, 0, r);
  }

  function prism(ctx, it) {   // 棱柱：底面正多边形(默认三角)沿深度拉伸
    var n = it.n || 3, side = it.side || 3, h = it.h || 4, depth = it.depth || 2.5;
    var r = side / (2 * Math.sin(Math.PI / n)), o = obOff(depth), rot = Math.PI / 2 + (n % 2 ? 0 : Math.PI / n);
    var base = [], top = [];
    for (var i = 0; i < n; i++) {
      var t = rot + i * 2 * Math.PI / n, bx = r * Math.cos(t) * 0.6, by = r * Math.sin(t) * 0.32; // 底面压扁成椭圆视角
      base.push(ctx.node(bx + o[0], by + o[1])); top.push(ctx.node(bx + o[0], by + o[1] + h));
    }
    for (var j = 0; j < n; j++) {
      var hid = (j === 0);  // 近似：第 0 条棱当隐藏
      ctx.seg(base[j], base[(j + 1) % n], hid ? DASH : null);
      ctx.seg(top[j], top[(j + 1) % n]);
      ctx.seg(base[j], top[j], hid ? DASH : null);
    }
    ctx.coverBox(o[0], h / 2 + o[1], r + 1, h / 2 + 1);
  }

  function pyramid(ctx, it) {  // 棱锥：底面正多边形(椭圆视角) + 顶点
    var n = it.n || 4, side = it.side || 3, h = it.h || 4;
    var r = side / (2 * Math.sin(Math.PI / n)), rot = Math.PI / 2 + (n % 2 ? 0 : Math.PI / n);
    var base = [], cx = 0, cy = 0;
    for (var i = 0; i < n; i++) { var t = rot + i * 2 * Math.PI / n; base.push(ctx.node(r * Math.cos(t), r * Math.sin(t) * 0.34)); }
    var apex = ctx.node(0, h);
    for (var j = 0; j < n; j++) {
      var hid = (j === n - 1);   // 近似一条底棱隐藏
      ctx.seg(base[j], base[(j + 1) % n], hid ? DASH : null);
      ctx.seg(apex, base[j]);
    }
    ctx.coverBox(0, h / 2, r + 0.5, h / 2 + 0.5);
  }

  /* ===================== 变换族（轴对称/平移/旋转/中心对称）===================== */
  function reflectPt(p, axis) {
    if (axis === 'x') return [p[0], -p[1]];
    if (axis === 'y') return [-p[0], p[1]];
    var a = axis[0], b = axis[1], dx = b[0] - a[0], dy = b[1] - a[1];
    var t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
    var fx = a[0] + t * dx, fy = a[1] + t * dy;
    return [2 * fx - p[0], 2 * fy - p[1]];
  }
  function rotatePt(p, c, ang) {
    var s = Math.sin(rad(ang)), co = Math.cos(rad(ang)), x = p[0] - c[0], y = p[1] - c[1];
    return [c[0] + x * co - y * s, c[1] + x * s + y * co];
  }
  function transformOp(ctx, it) {
    var fig = ctx.figures[it.of];
    if (!fig) throw new Error('transform 引用了不存在的图形: ' + it.of);
    if (fig.kind !== 'polygon') throw new Error('变换暂只支持多边形类图形: ' + it.of);
    var t = it.transform, mapPt;
    if (t === 'reflect') { var ax = it.axis || 'x'; mapPt = function (p) { return reflectPt(p, ax); }; }
    else if (t === 'translate') { var by = it.by || [3, 0]; mapPt = function (p) { return [p[0] + by[0], p[1] + by[1]]; }; }
    else if (t === 'rotate') { var ct = it.center || [0, 0], an = it.angle || 90; mapPt = function (p) { return rotatePt(p, ct, an); }; }
    else if (t === 'central') { var ct2 = it.center || [0, 0]; mapPt = function (p) { return [2 * ct2[0] - p[0], 2 * ct2[1] - p[1]]; }; }
    else throw new Error('未知 transform: ' + t);

    var newXY = fig.xy.map(mapPt);
    var newLabels = it.labels || fig.labels.map(function (l) { return l + "'"; });
    var figId = it.id || ctx.uid('tf');
    polygonFigure(ctx, figId, newXY, newLabels, true);
    // 画对称轴 / 对称中心 / 旋转中心（默认画，showAux:false 关）
    if (it.showAux !== false) {
      if (t === 'reflect') {
        // 对称轴用隐藏端点(不漏圆点)，范围取原像+像的 extent(不撑爆 bbox)；line 类型本身无限延伸
        var pool = fig.xy.concat(newXY), Ln;
        if (it.axis === 'x') { var xs = pool.map(function (p) { return p[0]; }); Ln = [[Math.min.apply(0, xs) - 1, 0], [Math.max.apply(0, xs) + 1, 0]]; }
        else if (it.axis === 'y') { var ys = pool.map(function (p) { return p[1]; }); Ln = [[0, Math.min.apply(0, ys) - 1], [0, Math.max.apply(0, ys) + 1]]; }
        else { Ln = it.axis; }
        ctx.objects.push({ id: ctx.uid('L'), type: 'line', points: [ctx.node(Ln[0][0], Ln[0][1]), ctx.node(Ln[1][0], Ln[1][1])], style: { dash: true, color: '#888' } });
      } else if (t === 'rotate' || t === 'central') {
        ctx.vertex(figId + 'c', it.centerLabel || 'O', (it.center || [0, 0])[0], (it.center || [0, 0])[1]);
      }
    }
    // 对应点连线（虚线，showMap:true 才画）
    if (it.showMap) { var nids = ctx.figures[figId].ids; fig.ids.forEach(function (id, i) { ctx.seg(id, nids[i], { dash: true, color: '#bbb' }); }); }
  }

  /* ===================== 工具 ===================== */
  function lineIntersect(A, B, C, D) {  // 直线 AB 与 CD 的交点，平行返回 null
    var a1 = B[1] - A[1], b1 = A[0] - B[0], c1 = a1 * A[0] + b1 * A[1];
    var a2 = D[1] - C[1], b2 = C[0] - D[0], c2 = a2 * C[0] + b2 * C[1];
    var det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 1e-9) return null;
    return [(b2 * c1 - b1 * c2) / det, (a1 * c2 - a2 * c1) / det];
  }
  function projectFoot(A, B, C) {  // A 到直线 BC 的垂足
    var bx = C[0] - B[0], by = C[1] - B[1], t = ((A[0] - B[0]) * bx + (A[1] - B[1]) * by) / (bx * bx + by * by);
    return [B[0] + t * bx, B[1] + t * by];
  }
  function circumcenter(A, B, C) {  // 外接圆心 + 半径 [cx,cy,R]，退化返回 null
    var d = 2 * (A[0] * (B[1] - C[1]) + B[0] * (C[1] - A[1]) + C[0] * (A[1] - B[1]));
    if (Math.abs(d) < 1e-9) return null;
    var ux = ((A[0] * A[0] + A[1] * A[1]) * (B[1] - C[1]) + (B[0] * B[0] + B[1] * B[1]) * (C[1] - A[1]) + (C[0] * C[0] + C[1] * C[1]) * (A[1] - B[1])) / d;
    var uy = ((A[0] * A[0] + A[1] * A[1]) * (C[0] - B[0]) + (B[0] * B[0] + B[1] * B[1]) * (A[0] - C[0]) + (C[0] * C[0] + C[1] * C[1]) * (B[0] - A[0])) / d;
    return [ux, uy, Math.hypot(A[0] - ux, A[1] - uy)];
  }
  function applyPlacement(P, it) {   // 整体旋转 + 平移（坐标精确性不受影响）
    var rot = it.rotate ? rad(it.rotate) : 0, at = it.at || [0, 0];
    return P.map(function (p) {
      var x = p[0], y = p[1];
      if (rot) { var nx = x * Math.cos(rot) - y * Math.sin(rot), ny = x * Math.sin(rot) + y * Math.cos(rot); x = nx; y = ny; }
      return [x + at[0], y + at[1]];
    });
  }
  function defaultLetters(n) { var A = 'ABCDEFGHIJKL', o = []; for (var i = 0; i < n; i++) o.push(A[i] || ('P' + i)); return o; }

  // auto-bbox：从所有点 + 显式 cover 范围（圆/椭圆/立体半径）算包围盒 + 留白
  function autoBBox(objs, cover, pad) {
    var xs = [], ys = [];
    objs.forEach(function (o) {
      if (o.type === 'point' && o.coords) { xs.push(o.coords[0]); ys.push(o.coords[1]); }
      if (o.type === 'circleOutline') { xs.push(o.cx - o.r, o.cx + o.r); ys.push(o.cy - o.r, o.cy + o.r); }
      if (o.type === 'sector') { xs.push(o.cx - o.r, o.cx + o.r); ys.push(o.cy - o.r, o.cy + o.r); }
      if (o.type === 'bar') { xs.push(o.x0, o.x1); ys.push(0, o.h); }
      if (o.type === 'curve' && o.xs) { o.xs.forEach(function (x) { xs.push(x); }); o.ys.forEach(function (y) { ys.push(y); }); }
    });
    (cover || []).forEach(function (p) { xs.push(p[0]); ys.push(p[1]); });
    if (!xs.length) return [-5, 5, 6, -3];
    var x0 = Math.min.apply(0, xs), x1 = Math.max.apply(0, xs), y0 = Math.min.apply(0, ys), y1 = Math.max.apply(0, ys);
    var m = Math.max((x1 - x0), (y1 - y0)) * (pad != null ? pad : 0.16) + 0.5;
    return [rnd(x0 - m), rnd(y1 + m), rnd(x1 + m), rnd(y0 - m)];  // [xmin,ymax,xmax,ymin]
  }

  var FigureBuilder = {
    expand: function (spec) {
      spec = spec || {};
      var ctx = new Ctx();
      (spec.build || []).forEach(function (it) {
        if (it.shape === 'triangle') triangle(ctx, it);
        else if (it.shape === 'quad') quad(ctx, it);
        else if (it.shape === 'regular') regular(ctx, it);
        else if (it.shape === 'circle') circle(ctx, it);
        else if (it.shape === 'arc') arcShape(ctx, it);
        else if (it.shape === 'function') func(ctx, it);
        else if (it.shape === 'solid') solid(ctx, it);
        else if (it.shape === 'chart') chart(ctx, it);
        else if (it.shape === 'numberline') numberLine(ctx, it);
        else if (it.shape === 'angle') angleShape(ctx, it);
        else if (it.shape === 'parallelCut') parallelCut(ctx, it);
        else if (it.shape === 'coordinate') coordinate(ctx, it);
        else if (it.shape === 'clock') clock(ctx, it);
        else if (it.shape === 'fractionBar') fractionBar(ctx, it);
        else if (it.shape === 'fractionCircle') fractionCircle(ctx, it);
        else if (it.shape === 'grid') gridArea(ctx, it);
        else if (it.transform) transformOp(ctx, it);
        else if (it.add) addOp(ctx, it);
        else if (it.mark) markOp(ctx, it);
        else throw new Error('未知构件项: ' + JSON.stringify(it));
      });
      var axis = spec.axis != null ? spec.axis : ctx.needAxis;
      var bbox = (spec.fit === false && spec.bbox) ? spec.bbox : autoBBox(ctx.objects, ctx.cover, spec.pad);
      return {
        bbox: bbox, axis: axis, grid: spec.grid || axis,
        keepAspect: spec.keepAspect != null ? spec.keepAspect : ((ctx.needAxis || ctx.noAspect) ? false : true),
        label: { autoPosition: spec.autoLabel !== false },
        objects: ctx.objects
      };
    }
  };

  root.FigureBuilder = FigureBuilder;
  if (typeof module !== 'undefined' && module.exports) module.exports = FigureBuilder;
})(typeof window !== 'undefined' ? window : this);
