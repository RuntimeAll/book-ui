import request from '@/http/request'

// ── 知识点讲义（KG course）接口类型 ───────────────────────────────────────────

/** 知识点内容块（正文）*/
export interface KgBlock {
  /** 块类型：讲解 | 名师解读 | 表格 | 思维导图 */
  type: '讲解' | '名师解读' | '表格' | '思维导图'
  /** 富文本 HTML，含 <mark>/<table>/<img> */
  content: string
}

/** 内嵌例题 */
export interface KgExample {
  /** 题 id（雪花 string） */
  qid: string
  /** 题型：1=选择 / 4=填空 / 5=解答 */
  type: 1 | 4 | 5
  /** 来源（如 "2024金华永康期末"） */
  source: string
  /** 题干 HTML */
  stem: string
  /** 答案 HTML */
  answer: string
  /** 详解 HTML */
  explain: string
}

/** 知识点节点 */
export interface KgKp {
  id: string
  name: string
  blocks: KgBlock[]
  keyConcepts: string[]
  examples: KgExample[]
}

/** 考点节点 */
export interface KgKaodian {
  id: string
  name: string
  kps: KgKp[]
}

/** 习题 / 巩固题（模块二/三） */
export interface KgExercise {
  qid: string
  type: 1 | 4 | 5
  source: string
  stem: string
  answer: string
  explain: string
}

/** 课时讲义响应（GET /teacher/kg/course/:courseId） */
export interface KgCourseResponse {
  course: {
    id: string
    name: string
  }
  /** 思维导图 OSS 图片 URL */
  mindmapUrl: string
  /** 考点列表（含知识点） */
  kaodians: KgKaodian[]
  /** 模块二：习题精练 */
  exercises: KgExercise[]
  /** 模块三：巩固提升 */
  boost: KgExercise[]
}

// ── 开关：true = 用 mock 数据（后端未就绪时），false = 接真实 /teacher/kg/course/{id} ──
export const USE_MOCK = true

// ── Mock 数据（1:1 参照 preview_full.html 的课时1 长度、体积的测量） ──────────────
const MOCK_DATA: KgCourseResponse = {
  course: { id: '901001002001', name: '课时1 长度、体积的测量' },
  mindmapUrl: 'https://ai-book.oss-cn-hangzhou.aliyuncs.com/kg/science/zj2024/g7s/1.2.1/mindmap.png',
  kaodians: [
    {
      id: 'kd_1',
      name: '长度测量',
      kps: [
        {
          id: 'kp_1_1',
          name: '测量的含义',
          blocks: [
            {
              type: '讲解',
              content: '测量是一个把<mark>待测的量</mark>与<mark>公认的标准</mark>进行比较的过程。<br>要测量物体的长度，要先规定长度的标准——长度单位，然后用合适的工具进行测量。',
            },
            {
              type: '名师解读',
              content: '<mark></mark>科学思维——比较法：通过观察、分析找到两类事物（现象、物理量等）的相同点和不同点的思想方法。没有比较就没有鉴别，比较有定性比较和定量比较两种。',
            },
            {
              type: '讲解',
              content: '测量其实就是一种定量比较，是将待测量与我们制订的 标准进行比较的过程。',
            },
          ],
          keyConcepts: ['待测的量', '公认的标准'],
          examples: [],
        },
        {
          id: 'kp_1_2',
          name: '长度的单位',
          blocks: [
            {
              type: '讲解',
              content: '在国际单位制中，长度的单位是<mark>米</mark>，符号是<mark>m</mark>。<br>还有千米（km）、分米（dm）、厘米（cm）、毫米（mm）、微米（um）、纳米（nm）等。<br>长度单位之间的换算关系<br>1km＝1000m &nbsp;&nbsp;&nbsp;&nbsp;1m＝10dm＝100cm＝1000mm<br>1mm＝1000μm &nbsp;&nbsp;1μm＝1000nm &nbsp;&nbsp;1m＝10<sup>6</sup>μm＝10<sup>9</sup>nm',
            },
            {
              type: '名师解读',
              content: '<mark></mark>①公认标准的由来：1960年，国际计量大会通过了一套统一的测量标准，叫国际单位制。长度的国际单位为米。<br><img src="https://ai-book.oss-cn-hangzhou.aliyuncs.com/kg/science/zj2024/g7s/1.2.1/convert.png" style="width:360px;max-width:100%">',
            },
            {
              type: '讲解',
              content: '②单位换算法则：<mark>大单位变为小单位，乘进率</mark>；小单位变为大单位，乘进率的倒数。等号两边为同一物理量的大小不同的单位。',
            },
          ],
          keyConcepts: ['大单位变为小单位，乘进率'],
          examples: [],
        },
        {
          id: 'kp_1_3',
          name: '长度的测量',
          blocks: [
            {
              type: '讲解',
              content: '测量工具：长度的常用测量工具有钢尺、木尺、三角板、卷尺等。<br><mark>零刻度线</mark>：测量范围的起点。<br><mark>最小刻度</mark>（<mark>分度值</mark>）：每一小格表示的量。<br><mark>量程</mark>（<mark>测量范围</mark>）：刻度尺一次能测出的<mark>最大</mark>长度。',
            },
            {
              type: '表格',
              content: '<table><tr><th>会选</th><td>根据测量要求选择<mark>分度值</mark>和<mark>量程</mark>适当的刻度尺。</td></tr><tr><th>会放</th><td>"会放"是使刻度尺有<mark>刻度线</mark>一侧紧贴被测物体的一端，并与所测物体平行。<br><img src="https://ai-book.oss-cn-hangzhou.aliyuncs.com/kg/science/zj2024/g7s/1.2.1/image4.png" style="width:117px;max-width:100%"></td></tr><tr><th>会看</th><td>读数时，视线要正对刻度线，即视线与尺面<mark>垂直</mark>，不能斜视。</td></tr><tr><th>会读</th><td>读数时，除准确读出分度值的数字外，还要估读到分度值的<mark>下一位数字</mark>。</td></tr><tr><th>会记</th><td>记录的数值＝准确值＋估计值＋<mark>单位</mark>；没有单位的数值是没有意义的。</td></tr></table>',
            },
            {
              type: '名师解读',
              content: '<mark></mark>①刻度尺的<mark>分度值</mark>决定了测量结果的<mark>精确程度</mark>。②通过测量结果的精确程度可判断所用刻度尺的分度值。',
            },
          ],
          keyConcepts: ['零刻度线', '最小刻度', '分度值', '量程', '测量范围', '最大', '单位', '刻度线'],
          examples: [
            {
              qid: 'ex_1',
              type: 5,
              source: '2025金华永康期末',
              stem: '科学研究过程中经常要进行测量，测量时正确读数很关键，请根据图示填空。如图所示，用四把刻度尺测同一木块的长度。<br><img src="https://ai-book.oss-cn-hangzhou.aliyuncs.com/kg/science/zj2024/g7s/1.2.1/image7.png" style="width:555px;max-width:100%"><br>①图中四种测量方法正确的有<mark>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</mark>（填字母）。②正确的测量方法中，木块长度精确度更高的测量值为<mark>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</mark>厘米。',
              answer: '①AC；② 3.30',
              explain: '②A图中刻度尺的分度值为5mm，C图中刻度尺的分度值较小，测量精确度更高，则读数为3.30cm。',
            },
          ],
        },
      ],
    },
    {
      id: 'kd_2',
      name: '体积测量',
      kps: [
        {
          id: 'kp_2_1',
          name: '体积和容积',
          blocks: [
            {
              type: '讲解',
              content: '体积：物体占有空间的大小；容积：能容纳物体的体积。',
            },
          ],
          keyConcepts: [],
          examples: [],
        },
        {
          id: 'kp_2_2',
          name: '液体体积的测量',
          blocks: [
            {
              type: '讲解',
              content: '测量工具：量筒、量杯。<br>使用前要"<mark>二看</mark>"：一看<mark>测量范围</mark>（<mark>量程</mark>）；二看<mark>最小刻度</mark>（<mark>分度值</mark>）。',
            },
            {
              type: '表格',
              content: '<table><tr><th>选对</th><td>根据测量液体的要求及量筒的<mark>测量范围</mark>和<mark>最小刻度</mark>，选择合适的量筒。</td></tr><tr><th>放对</th><td>量筒使用时，要放置在<mark>水平</mark>桌面上。</td></tr><tr><th>看对</th><td>读数时，视线应与量筒内液体<mark>凹液面的最低处</mark>或<mark>凸液面的最高处</mark>保持水平，再读出液体的体积。</td></tr><tr><th>记对</th><td>记录读数，并注明所用的<mark>单位</mark>。</td></tr></table>',
            },
            {
              type: '名师解读',
              content: '<mark></mark>仰视和俯视读数误差分析：<mark>仰视</mark>时视线<mark>斜向上</mark>，视线与筒壁的交点在液面下方，所以<mark>读数偏小</mark>；<mark>俯视</mark>时视线<mark>斜向下</mark>，视线与筒壁的交点在液面上方，所以<mark>读数偏大</mark>。',
            },
          ],
          keyConcepts: ['二看', '测量范围', '量程', '最小刻度', '分度值', '水平'],
          examples: [
            {
              qid: 'ex_2',
              type: 1,
              source: '',
              stem: '用量筒测量液体的体积时，小明先采用仰视读数，读出液体的体积为45mL，然后倒出部分液体后，采用俯视读数，读出液体的体积为30mL。则他倒出的液体体积（&nbsp;&nbsp;&nbsp;&nbsp;）<br>A.大于15mL &nbsp;&nbsp;&nbsp;B.小于15mL &nbsp;&nbsp;&nbsp;C.等于15mL &nbsp;&nbsp;&nbsp;D.都有可能',
              answer: 'A',
              explain: '用量筒量取液体时，仰视读数偏小，俯视读数偏大，故倒之前实际体积大于45mL；倒出部分液体后，实际体积小于30mL，所以倒出液体的体积大于15mL。',
            },
          ],
        },
      ],
    },
  ],
  exercises: [
    {
      qid: 'e1',
      type: 1,
      source: '',
      stem: '小科在记录一些长度的测量结果时，忘记写单位，试判断下列哪个数据的单位是cm（&nbsp;&nbsp;&nbsp;&nbsp;）<br>A.物理书的长是2.25 &nbsp;&nbsp;&nbsp;B.一支圆铅笔的直径是7.1<br>C.茶杯的高度是9.5 &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;D.黑板的宽是1.28',
      answer: 'C',
      explain: '物理书的长是2.25dm；一支圆铅笔的直径是7.1mm；茶杯的高度是9.5cm；黑板的宽是1.28m。本题应选C。',
    },
    {
      qid: 'e2',
      type: 1,
      source: '',
      stem: '某同学用刻度尺量出一本书的厚度为1.30cm，这本书共有260页。则每张纸的厚度是（&nbsp;&nbsp;&nbsp;&nbsp;）<br>A.0.05mm &nbsp;&nbsp;&nbsp;B.0.005cm &nbsp;&nbsp;&nbsp;C.0.1cm &nbsp;&nbsp;&nbsp;D.0.1mm',
      answer: 'D',
      explain: '一张纸有两页，因此260页总共是130张纸，每张纸厚度为1.30cm÷130≈0.01cm=0.1mm，故D正确。',
    },
    {
      qid: 'e3',
      type: 1,
      source: '2024台州调研',
      stem: '（2024台州调研）如图是某同学用刻度尺测量一金属片长度的情形。<br><img src="https://ai-book.oss-cn-hangzhou.aliyuncs.com/kg/science/zj2024/g7s/1.2.1/image31.png" style="width:196px;max-width:100%"><br>该刻度尺的分度值为<mark>&nbsp;&nbsp;&nbsp;&nbsp;</mark>。A、B两种测量方法，正确的是<mark>&nbsp;&nbsp;&nbsp;</mark>。用正确方法测得金属片的长度为<mark>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</mark>cm。',
      answer: '（1）1mm（或0.1cm）&nbsp;&nbsp;（2）B&nbsp;&nbsp;（3）2.73',
      explain: '（1）刻度尺上1cm有10个小格，即分度值是1mm。（2）刻度尺有刻度的一边应紧靠被测物体，故B正确。（3）读数为2.73cm。',
    },
  ],
  boost: [
    {
      qid: 'b1',
      type: 1,
      source: '',
      stem: '原来在<mark>量筒</mark>中盛有50mL的酒精，小明要取出15mL的酒精，结果另一个同学发现小明倒完后<mark>俯视</mark>原来量筒读数，你认为小明实际倒出的酒精体积（&nbsp;&nbsp;&nbsp;&nbsp;）<br>A.大于15mL &nbsp;&nbsp;B.等于15mL &nbsp;&nbsp;C.小于15mL &nbsp;&nbsp;D.无法确定',
      answer: 'A',
      explain: '俯视量筒读数会使读数偏大，则实际剩余的液体偏小，即倒出的液体偏多。本题应选A。',
    },
    {
      qid: 'b2',
      type: 1,
      source: '',
      stem: '下列对一些常见物体的估测最恰当的是（&nbsp;&nbsp;&nbsp;&nbsp;）<br>A.中学生课桌高度约80cm &nbsp;&nbsp;&nbsp;B.物理课本长度约50cm<br>C.学校教室的长度约20cm &nbsp;&nbsp;&nbsp;D.学生用笔直径约4cm',
      answer: 'A',
      explain: '中学生用的普通课桌高度约为0.8m=80cm，A项正确；物理课本的长度约为26cm，B项错误；学校教室的长度约为10m，C项错误；学生用笔的直径约为7mm，D项错误。',
    },
    {
      qid: 'b3',
      type: 1,
      source: '2023金华期中',
      stem: '（2023金华期中）义乌市区中小学全面推广使用"彩虹标尺"来调整课桌椅的高度。小科利用"彩虹标尺"测自己的身高，先后四次测得的结果分别为165.2cm，165.0cm，165.1cm，165.1cm。则下列说法正确的是（&nbsp;&nbsp;&nbsp;&nbsp;）<br>A.该彩虹标尺的分度值是1mm<br>B.165.0cm中最末一位数字"0"没有意义<br>C.几次结果有差异与测量的工具有关<br>D.最终的测量结果应记作165.1cm',
      answer: 'D',
      explain: '分度值是1cm，A错误；"0"为估读数字有意义，B错误；差异与估读的不同有关，C错误；取平均值165.1cm，D正确。',
    },
  ],
}

/**
 * 获取课时讲义（GET /teacher/kg/course/:courseId）。
 * USE_MOCK=true 时跳过网络请求，返回本地 mock 数据（后端未就绪时使用）。
 * USE_MOCK=false 时调真实接口，envelope 由拦截器解包，返 response 内层。
 */
export const getCourseDetail = (courseId: string): Promise<KgCourseResponse> => {
  if (USE_MOCK) {
    return Promise.resolve(MOCK_DATA)
  }
  return request.get<KgCourseResponse, KgCourseResponse>(`/teacher/kg/course/${courseId}`)
}
