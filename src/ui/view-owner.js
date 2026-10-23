/* 擁有者後台：帳號、回收區、系統設定、備份與跨年度結算 */
(function (App) {
  'use strict';

  // ---------- 範例資料（單機版試用） ----------
  function sampleV2() {
    const today = App.today();
    const names = {
      kids: [['K01', '林小安', '孝順隊'], ['K02', '陳小晴', '孝順隊'], ['K03', '張小宇', '仁愛隊'], ['K04', '黃小恩', '仁愛隊'], ['K05', '李小翰', '智慧隊'], ['K06', '吳小潔', '智慧隊']],
      youth: [['Y01', '王小廷', '慈悲組'], ['Y02', '許小瑜', '慈悲組'], ['Y03', '劉小均', '精進組'], ['Y04', '蔡小蓁', '精進組'], ['Y05', '鄭小翔', '喜捨組'], ['Y06', '楊小晴', '喜捨組']]
    };
    const students = [];
    Object.keys(names).forEach(function (classType) {
      names[classType].forEach(function (n, i) {
        const honor = 60 + ((i * 37) % 200);
        students.push({ id: n[0], classType: classType, name: n[1], team: n[2], honorPoints: honor, availablePoints: honor - (i % 3) * 20, attendedDates: [] });
      });
    });
    return { templeTitle: '範例佛堂｜年度班程報到加分系統', yearLabel: today.slice(0, 4) + ' 年度', students: students, logs: [] };
  }

  App.actions['load-sample'] = function () {
    App.confirm('載入 12 位範例學員、兩個班別與禮品目錄，方便試用。\n之後可以在「擁有者」分頁清除或匯入正式資料。', { okLabel: '載入範例' }).then(function (yes) {
      if (!yes) return;
      App.s.backend.importState(JSON.stringify(sampleV2())).then(function (res) {
        App.loadData(res.state);
        App.render();
        App.toast('📦 已載入範例資料', 'ok');
      }, App.handleError);
    });
  };
})(window.App = window.App || {});
