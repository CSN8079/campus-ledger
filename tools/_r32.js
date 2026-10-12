const fs = require('fs');
const path = require('path');
const ROOT = __dirname + '/..';
const p = 'tests/browser-suite.js';
const full = path.join(ROOT, p);
const raw = fs.readFileSync(full, 'utf8');
const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
let text = raw.split('\r\n').join('\n');

var SEC = [
"  /* ---------- 53. 节假日提醒与联网获取（测试版） ---------- */",
"  const holBak = { data: Store.settings.holidayData, prompts: Store.settings.holidayPrompts };",
"  const soonIso = U.toISODate(U.addDays(new Date(), 3));",
"  const soonEndIso = U.toISODate(U.addDays(new Date(), 6));",
"  const holKey = '国庆|' + soonIso;",
"  await Store.updateSettings({",
"    holidayData: { fetchedAt: Date.now(), source: '测试', list: [{ key: holKey, name: '国庆', start: soonIso, end: soonEndIso }] },",
"    holidayPrompts: {},",
"    vacationExclude: true",
"  });",
"  UI.go('home');",
"  await wait(520);",
"  ok(!!$('#view-home .holiday-card'), '概览上出现了节假日提醒');",
"  const hcTxt = $('#view-home .holiday-card').textContent;",
"  ok(hcTxt.indexOf('国庆') >= 0, '写着是哪个假期');",
"  ok(hcTxt.indexOf('测试版') >= 0, '标了「测试版」');",
"  ok(hcTxt.indexOf('还有') >= 0, '写着还剩几天');",
"  const hcRefuse = $$('#view-home .holiday-card button').filter((b) => b.textContent === '照常计入')[0];",
"  ok(!!hcRefuse, '有「照常计入」这个选择');",
"  if (hcRefuse) hcRefuse.click();",
"  await wait(560);",
"  ok(!$('#view-home .holiday-card'), '选过之后提醒就消失了（不会一直弹）');",
"  eq(Holiday.isHandled(holKey), true, '记下了已经处理过');",
"",
"  /* 「设为假期」这条路 */",
"  await Store.updateSettings({ holidayPrompts: {} });",
"  UI.renderHome();",
"  await wait(420);",
"  const hcAccept = $$('#view-home .holiday-card button').filter((b) => b.textContent.indexOf('设为假期') >= 0)[0];",
"  ok(!!hcAccept, '有「设为假期（不计入统计）」按钮');",
"  if (hcAccept) hcAccept.click();",
"  await wait(680);",
"  ok(Store.vacations().some((v) => v.name === '国庆'), '一点就加进了假期列表');",
"  ok(!$('#view-home .holiday-card'), '提醒消失');",
"",
"  /* 假期面板里的联网获取区 */",
"  UI.go('settings');",
"  await wait(420);",
"  ok($('#view-settings').textContent.indexOf('测试版') >= 0, '设置页也标了测试版');",
"  UI.openVacationSheet();",
"  await wait(560);",
"  ok($('#sheetRoot').textContent.indexOf('节假日数据') >= 0, '假期面板里有「节假日数据」一栏');",
"  ok($('#sheetRoot').textContent.indexOf('从网上获取') >= 0, '有联网获取按钮');",
"  const hSrc = $$('#sheetRoot input.input').filter((el) => String(el.value).indexOf('http') === 0)[0];",
"  ok(!!hSrc, '数据源地址可以自己改：' + (hSrc ? hSrc.value : '-'));",
"  ok($('#sheetRoot').textContent.indexOf('解析粘贴的数据') >= 0, '取不到时还能手动粘贴 JSON');",
"  const hPaste = $('#sheetRoot textarea');",
"  ok(!!hPaste, '有粘贴框');",
"  if (hPaste) {",
"    hPaste.value = JSON.stringify([{ name: '粘贴测试假', start: '2027-03-01', end: '2027-03-03' }]);",
"    const parseBtn = $$('#sheetRoot button').filter((b) => b.textContent === '解析粘贴的数据')[0];",
"    if (parseBtn) parseBtn.click();",
"    await wait(640);",
"    ok($('#sheetRoot').textContent.indexOf('粘贴测试假') >= 0, '解析出来后列在下面等着勾选');",
"    const addBtn = $$('#sheetRoot button').filter((b) => b.textContent.indexOf('把勾选的加进假期') >= 0)[0];",
"    ok(!!addBtn, '有「把勾选的加进假期」按钮');",
"    if (addBtn) addBtn.click();",
"    await wait(760);",
"    ok(Store.vacations().some((v) => v.name === '粘贴测试假'), '加进假期列表了');",
"  }",
"  UI.closeSheet();",
"  await wait(460);",
"",
"  /* 收尾：把测试造的假期与数据都还原 */",
"  const vList53 = Store.vacations().slice();",
"  for (let i53 = 0; i53 < vList53.length; i53++) {",
"    const nm = vList53[i53].name;",
"    if (nm === '国庆' || nm === '粘贴测试假') await Store.removeVacation(vList53[i53].id);",
"  }",
"  await Store.updateSettings({ holidayData: holBak.data, holidayPrompts: holBak.prompts });",
"  eq(Store.vacations().filter((v) => v.name === '粘贴测试假').length, 0, '收尾：测试假期已清掉');",
"  UI.go('home');",
"  await wait(320);",
"",
""
].join('\n');

const anchor = "  UI.go('home');\n  await wait(250);\n\n  return {\n";
const n = text.split(anchor).length - 1;
if (n !== 1) throw new Error('anchor not found (' + n + ')');
text = text.replace(anchor, () => SEC + anchor);
fs.writeFileSync(full, eol === '\n' ? text : text.split('\n').join('\r\n'), 'utf8');
console.log('r32 ok');
