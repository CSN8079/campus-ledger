/* ============================================================
   defaults.js - 预设分类、分类包、导入自动分类规则、默认设置
   ============================================================ */
(function (global) {
  'use strict';

  const D = {};

  /* ---------- 版本号（改这一个地方，界面上会跟着变） ---------- */
  D.APP_VERSION = '2.0.0';

  /* ---------- 记账账户 ---------- */
  D.accounts = ['微信', '支付宝', '银行卡', '现金', '校园卡', '其他'];

  /* ---------- 不计入统计的原因 ---------- */
  D.excludeReasons = [
    { id: 'reimburse', name: '报销', desc: '父母/他人报销，钱会还给我' },
    { id: 'advance', name: '代付', desc: '帮别人垫付，之后收回' },
    { id: 'loan', name: '借还款', desc: '借出或还回的钱' },
    { id: 'transfer', name: '账户互转', desc: '自己账户之间转账' },
    { id: 'ignore', name: '不计收支', desc: '其它不计入统计的流水' }
  ];

  /* ---------- 支出分类（内置） ---------- */
  D.expenseCategories = [
    { name: '餐饮', icon: '🍚', color: '#f97316' },
    { name: '交通', icon: '🚌', color: '#0ea5e9' },
    { name: '学习', icon: '📚', color: '#6366f1' },
    { name: '购物', icon: '🛍️', color: '#ec4899' },
    { name: '娱乐', icon: '🎮', color: '#8b5cf6' },
    { name: '住宿', icon: '🏠', color: '#f59e0b' },
    { name: '日用', icon: '🧴', color: '#84cc16' },
    { name: '医疗', icon: '💊', color: '#ef4444' },
    { name: '通讯', icon: '📱', color: '#14b8a6' },
    { name: '人情', icon: '🎁', color: '#a855f7' },
    { name: '运动', icon: '🏀', color: '#22c55e' },
    { name: '数码', icon: '💻', color: '#0891b2' },
    { name: '旅行', icon: '✈️', color: '#06b6d4' },
    { name: '其他', icon: '📦', color: '#64748b' }
  ];

  /* ---------- 收入分类（内置） ---------- */
  D.incomeCategories = [
    { name: '生活费', icon: '💰', color: '#12a594' },
    { name: '奖学金', icon: '🏆', color: '#f59e0b' },
    { name: '兼职', icon: '💼', color: '#6366f1' },
    { name: '报销', icon: '🎫', color: '#8b5cf6' },
    { name: '红包', icon: '🧧', color: '#e5484d' },
    { name: '退款', icon: '↩️', color: '#0ea5e9' },
    { name: '转账', icon: '↪️', color: '#14b8a6' },
    { name: '其他增收', icon: '💵', color: '#64748b' }
  ];

  /* ---------- 分类预设包：一键生成一套分类 ---------- */
  D.categoryPacks = [
    {
      id: 'college',
      name: '大学生常用（推荐）',
      desc: '14 个支出分类 + 8 个收入分类，覆盖校园日常',
      expense: D.expenseCategories.map((c) => c.name),
      income: D.incomeCategories.map((c) => c.name)
    },
    {
      id: 'minimal',
      name: '极简 7 类',
      desc: '只保留最常用的几类，记账更快',
      expense: ['餐饮', '交通', '学习', '购物', '娱乐', '住宿', '其他'],
      income: ['生活费', '兼职', '红包', '其他增收']
    },
    {
      id: 'detailed',
      name: '细分开销',
      desc: '在常用基础上增加订阅、健身、护肤等细分项',
      extraExpense: [
        { name: '订阅', icon: '🔁', color: '#6366f1' },
        { name: '健身', icon: '💪', color: '#22c55e' },
        { name: '护肤', icon: '🧖', color: '#ec4899' },
        { name: '咖啡奶茶', icon: '🧋', color: '#f97316' },
        { name: '资料打印', icon: '🖨️', color: '#14b8a6' }
      ],
      expense: D.expenseCategories.map((c) => c.name).concat(['订阅', '健身', '护肤', '咖啡奶茶', '资料打印']),
      income: D.incomeCategories.map((c) => c.name)
    }
  ];

  /* ---------- 内置自动分类规则（导入账单时按关键词猜测分类） ---------- */
  D.builtinRules = [
    { cat: '餐饮', type: 'expense', kw: ['食堂', '美团', '饿了么', '外卖', '肯德基', '麦当劳', '必胜客', '星巴克', '瑞幸', '蜜雪', '奶茶', '咖啡', '烧烤', '火锅', '米线', '面馆', '快餐', '餐饮', '小吃', '早餐', '午餐', '晚餐', '食品', '生鲜', '菜市场', '饭店', '餐厅', '汉堡', '披萨', '螺蛳粉', '食堂', '零食', '便利店', '牛肉面', '拉面', '刀削面', '盖饭', '炒饭', '麻辣烫', '包子', '豆浆', '油条', '饺子', '烤肉', '自助餐', '甜品'] },
    { cat: '交通', type: 'expense', kw: ['地铁', '公交', '轨道交通', '滴滴', '打车', '出租车', '网约车', '高铁', '火车', '12306', '机票', '航空', '共享单车', '哈啰', '青桔', '美团单车', '加油', '停车', 'ETC', '高速', '客车', '汽车票', '顺风车', 'T3出行', '曹操出行'] },
    { cat: '学习', type: 'expense', kw: ['学费', '教材', '书店', '图书', '图书馆', '打印', '复印', '文具', '知网', '考试', '报名费', '课程', '培训', '网课', '四六级', '考研', '学信网', '教育', '论文', '查重'] },
    { cat: '住宿', type: 'expense', kw: ['房租', '住宿', '宿舍', '物业', '水费', '电费', '燃气', '暖气', '租房', '公寓', '中介', '青年旅舍', '酒店', '宾馆', '民宿'] },
    { cat: '通讯', type: 'expense', kw: ['话费', '流量', '移动', '联通', '电信', '宽带', '校园网', '充值中心', '通讯'] },
    { cat: '医疗', type: 'expense', kw: ['医院', '药房', '药店', '诊所', '挂号', '门诊', '体检', '医药', '口腔', '眼镜', '医疗'] },
    { cat: '娱乐', type: 'expense', kw: ['电影', '影院', '游戏', 'steam', '网吧', 'KTV', '音乐', '演唱会', '视频会员', '腾讯视频', '爱奇艺', '优酷', '哔哩', 'B站', '网易云', '剧本杀', '密室', '桌游', '景点', '门票', '游乐'] },
    { cat: '运动', type: 'expense', kw: ['健身房', '游泳', '球馆', '羽毛球', '篮球', '跑步', 'keep', '运动', '瑜伽', '体育馆'] },
    { cat: '数码', type: 'expense', kw: ['小米', '华为', '苹果', '京东自营', '充电宝', '耳机', '键盘', '鼠标', '显示器', '电脑', '手机', '数据线', '数码'] },
    { cat: '日用', type: 'expense', kw: ['超市', '百货', '日用品', '洗护', '纸巾', '牙膏', '理发', '洗衣', '快递', '菜鸟', '丰巢', '印刷', '五金', '名创优品', '屈臣氏', '沃尔玛', '永辉', '大润发', '家乐福'] },
    { cat: '购物', type: 'expense', kw: ['淘宝', '天猫', '京东', '拼多多', '唯品会', '得物', '苏宁', '服饰', '优衣库', '鞋', '衣服', '购物', '商城', '直播间', '小红书'] },
    { cat: '旅行', type: 'expense', kw: ['携程', '去哪儿', '飞猪', '旅行', '旅游', '景区', '青旅', '签证'] },
    { cat: '人情', type: 'expense', kw: ['红包', '礼金', '份子', '随礼', '礼物', '花店', '蛋糕', '请客', '代付'] },
    /* 收入 */
    { cat: '生活费', type: 'income', kw: ['生活费', '家里', '父母', '爸爸', '妈妈', '老爸', '老妈', '爸', '妈', '转账-生活'] },
    { cat: '奖学金', type: 'income', kw: ['奖学金', '助学金', '补助', '补贴', '国家助学', '励志'] },
    { cat: '兼职', type: 'income', kw: ['工资', '兼职', '实习', '劳务', '报酬', '薪资', '薪酬', '家教', '稿费', '结课'] },
    { cat: '红包', type: 'income', kw: ['红包', '压岁钱', '微信红包', '群收款'] },
    { cat: '退款', type: 'income', kw: ['退款', '退货', '赔付', '赔偿', '退回'] },
    { cat: '报销', type: 'income', kw: ['报销', '报账'] }
  ];

  /* ---------- 默认设置 ---------- */
  D.settings = {
    theme: 'auto',              // auto | light | dark
    weekStart: 1,               // 1 = 周一，0 = 周日
    currency: '¥',
    semesters: [],              // [{id,name,start,end}]
    activeSemesterId: '',
    hideExcludedInList: false,  // 明细列表默认隐藏“不计入统计”的账单
    autoClassifyOnImport: true,
    dedupeOnImport: true,
    reportTitle: '大学生活记账本',   // 导出图片报告时的抬头
    autoBackup: true,          // 自动备份开关
    backupKeep: 10,            // 保留最近几份应用内快照
    backupIntervalHours: 24,   // 隔多久自动备份一次
    rules: [],                  // 用户自定义规则 [{id,kw:[],cat,type}]
    onboarded: false
  };

  /* ---------- 学期推断（无配置时给出一个合理默认） ---------- */
  /* 规则：2 月~7 月为春季学期，9 月~次年 1 月为秋季学期 */
  D.guessSemester = function (date) {
    const d = date ? new Date(date) : new Date();
    const y = d.getFullYear(), m = d.getMonth() + 1;
    if (m >= 7 && m <= 8) {
      const start = y + '-09-01', end = (y + 1) + '-01-15';
      return { name: y + ' 秋季学期', start: start, end: end };
    }
    if (m >= 2 && m <= 6) return { name: y + ' 春季学期', start: y + '-02-24', end: y + '-07-05' };
    if (m === 1) return { name: (y - 1) + ' 秋季学期', start: (y - 1) + '-09-01', end: y + '-01-15' };
    return { name: y + ' 秋季学期', start: y + '-09-01', end: (y + 1) + '-01-15' };
  };

  /* ---------- 报销/支出类型的一些枚举 ---------- */
  D.txType = { expense: '支出', income: '收入' };

  global.DEFAULTS = D;
})(window);