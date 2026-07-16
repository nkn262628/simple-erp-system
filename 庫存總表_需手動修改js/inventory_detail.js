(function () {
    'use strict';

    /* ═══════════════════════════════════════════════
       庫存明細（create / edit / detail）專用 inventory-detail.js
       ═══════════════════════════════════════════════ */

    /* ═══════════════════════════════════════════════
    ⚠️ 套用到新環境／新 App 前，請確認以下設定：
 
    🔧 1. CONFIG.PURCHASE_APP_ID / SALES_APP_ID / TRANSFER_APP_ID
          跨 App 參照的 App ID，換環境（例如從測試環境搬到正式環境）
          這三個一定要重新確認，因為不同環境的 App ID 通常不一樣。
 
    🔧 2. CONFIG.FIELDS 底下每個欄位代碼
          對應採購單／銷貨單／調撥單三個 App 的子表與欄位代碼，
          如果那三個 App 的欄位有改名，這裡要同步更新。
 
    🔧 3. 本檔案中直接寫在程式碼裡（不在 CONFIG 裡）的欄位代碼：
          商品料號、庫存識別鍵、倉庫名稱、倉庫編號、在庫量、
          安全庫存量、進貨量、出貨量、預約保留量、廢品數量、
          商品單位、商品名稱、庫存狀態
          這些都是「庫存 App 本身」的欄位代碼，換到別的庫存 App 要核對。
 
    🔧 4. #record-gaia .layout-gaia（原生欄位收合用的 DOM selector）
          這是 kintone 內部畫面結構，理論上通用，但如果 kintone
          未來改版導致收合按鈕失效，第一個要檢查的就是這個 selector。
 
    ✅ localStorage 的 key 名稱（PREFILL_CODE_KEY 等）不用改，
       除非你在同一個瀏覽器裡跑多套不同的庫存系統會互相污染。

    ⚠️ 5. 「累計入庫量／累計出庫量」小卡片 vs 區間統計「進貨量／出貨量」：
          這兩組數字語意不同，改動前務必先理解差異，避免又改回混淆的命名：
          - 累計入庫量／累計出庫量（miniCard）：直接讀庫存 App 的
            進貨量／出貨量欄位，這是「倉庫庫存總帳」，含採購、銷貨、
            調撥所有來源，用來驗算在庫量。
          - 區間統計 進貨量／出貨量（periodHtml + renderPeriodStats）：
            刻意只篩 source==='purchase' 與 source==='sales'，代表
            「真正的採購/銷貨業務量」，調撥視為內部倉庫間移動，
            不計入這組數字。
       ═══════════════════════════════════════════════ */

    /* ─────────────────────────────────────────────
       CONFIG：集中管理跨 App 參照與欄位代碼

       未來要做成 plugin（比照 auto-number-plugin／barcode-plugin）時，
       只需要把這個物件改成從 kintone.plugin.app.getConfig() 讀取，
       下面所有邏輯都不用動。
       ───────────────────────────────────────────── */
    var CONFIG = {
        PURCHASE_APP_ID: 16, // 🔧 [需依環境修改] 採購單 App ID
        SALES_APP_ID: 17,    // 🔧 [需依環境修改] 銷貨單 App ID
        TRANSFER_APP_ID: 20, // 🔧 [需依環境修改] 調撥單 App ID

        TIMELINE_FETCH_LIMIT: 50,    // 每個來源 API 撈取筆數上限
        TIMELINE_DISPLAY_LIMIT: 15,  // Timeline 畫面上顯示的筆數上限

        // localStorage 中介 key（跨 App 帶入新增畫面用）
        PREFILL_CODE_KEY: 'inv_prefill_商品料號',
        PREFILL_WAREHOUSE_KEY: 'inv_prefill_收貨倉庫',


        // 🔧 [需依環境修改] 以下 FIELDS 三組都是採購單／銷貨單／調撥單
        //    各自 App 的欄位代碼，換 App 時要逐一核對
        FIELDS: {
            purchase: {
                dateField: '進貨日期',
                orderNoField: '採購單號',
                detailTable: '採購內容',
                codeField: '商品料號',
                warehouseField: '收貨倉庫',
                receivedQtyField: '已入庫數量',
                receivedStatusField: '是否入庫'
            },
            sales: {
                dateField: '銷貨日期',
                orderNoField: '採購單號', // 沿用既有欄位代碼設定
                detailTable: '銷售內容',
                codeField: '商品料號',
                warehouseField: '出貨倉庫',
                qtyField: '數量',
                closedField: '是否結案',
                closedValue: '已結案'
            },
            transfer: {
                dateField: '調撥日期',
                orderNoField: '調撥單號',
                statusField: '調撥狀態',
                completeValue: '調撥完成',
                typeField: '調撥性質',
                fromField: '撥出倉庫',
                toField: '撥入倉庫',
                detailTable: '調撥內容',
                codeField: '商品料號',
                qtyField: '調撥數量'
            }
        }
    };

    function getStatus(inStock, safeStock) {
        if (inStock <= 0) return 'empty';
        if (inStock < safeStock) return 'low';
        return 'ok';
    }
    function statusEmoji(s) {
        return s === 'empty' ? '缺貨' : s === 'low' ? '低庫存' : '正常';
    }
    function escapeHtml(str) {
        return (str || '')
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /* ─────────────────────────────────────────────
       區間統計：日期區間計算

       改用 'YYYY-MM-DD' 字串直接比對，不經過 Date 物件／時區轉換，
       避免月初、月底的資料因時區問題被誤判成不在區間內。
       ───────────────────────────────────────────── */
    function pad2(n) { return n < 10 ? '0' + n : String(n); }
    function toDateStr(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }

    function getPeriodRange(period) {
        var now = new Date();
        var y = now.getFullYear();
        var m = now.getMonth(); // 0-11
        var startStr, endStr;

        if (period === 'month') {
            startStr = toDateStr(y, m, 1);
            endStr = toDateStr(y, m + 1, 0); // 下個月第 0 天 = 這個月最後一天
        } else if (period === 'quarter') {
            var q = Math.floor(m / 3);
            startStr = toDateStr(y, q * 3, 1);
            endStr = toDateStr(y, q * 3 + 3, 0);
        } else if (period === 'year') {
            startStr = y + '-01-01';
            endStr = y + '-12-31';
        } else {
            return null; // 'all' → 不限制區間
        }
        return { start: startStr, end: endStr };
    }

    function inRange(dateStr, range) {
        if (!range) return true;         // 累計：不限制
        if (!dateStr) return false;      // 沒有日期的資料，區間篩選一律排除
        var d = String(dateStr).slice(0, 10); // 只取 YYYY-MM-DD 部分，容錯 datetime 格式
        return d >= range.start && d <= range.end;
    }

    /* ── 編輯 / 新增畫面計算 ──
       🔧 [需依環境修改] 以下欄位代碼都是「庫存 App 本身」的欄位 */
    function calcAndUpdate(record) {
        var 進貨量 = parseFloat(record['進貨量'].value) || 0;
        var 出貨量 = parseFloat(record['出貨量'].value) || 0;
        var 預約保留量 = parseFloat(record['預約保留量'].value) || 0;
        var 廢品數量 = parseFloat(record['廢品數量'].value) || 0;
        var inStock = 進貨量 - 出貨量 - 預約保留量 - 廢品數量;
        var safeStock = parseFloat(record['安全庫存量'].value) || 0;
        var st = getStatus(inStock, safeStock);
        record['在庫量'].value = inStock;
        record['庫存狀態'].value = st === 'empty' ? '🔴 缺貨' : st === 'low' ? '🟡 低庫存' : '🟢 正常';
    }
    function updateKey(record) {
        var wc = record['倉庫編號'].value || '';
        var pc = record['商品料號'].value || '';
        if (wc && pc) record['庫存識別鍵'].value = wc + '-' + pc;
    }

    kintone.events.on(['app.record.create.show', 'app.record.edit.show',
        'mobile.app.record.create.show', 'mobile.app.record.edit.show'],
        function (e) { calcAndUpdate(e.record); return e; });
    var STOCK_FIELDS = ['進貨量', '出貨量', '預約保留量', '廢品數量', '安全庫存量'];
    var changeEvents = [];
    STOCK_FIELDS.forEach(function (f) {
        changeEvents.push('app.record.create.change.' + f);
        changeEvents.push('app.record.edit.change.' + f);
        changeEvents.push('mobile.app.record.create.change.' + f);
        changeEvents.push('mobile.app.record.edit.change.' + f);
    });
    kintone.events.on(changeEvents, function (e) { calcAndUpdate(e.record); return e; });
    kintone.events.on([
        'app.record.create.change.倉庫編號', 'app.record.edit.change.倉庫編號',
        'app.record.create.change.商品料號', 'app.record.edit.change.商品料號'
    ], function (e) { updateKey(e.record); calcAndUpdate(e.record); return e; });

    /* ── 詳細頁顯示 ── */
    kintone.events.on(['app.record.detail.show', 'mobile.app.record.detail.show'], function (event) {
        var isMobile = event.type === 'mobile.app.record.detail.show';
        var record = event.record;
        var inStock = parseFloat(record['在庫量'].value) || 0;
        var safeStock = parseFloat(record['安全庫存量'].value) || 0;
        var 進貨量 = parseFloat(record['進貨量'].value) || 0;
        var 出貨量 = parseFloat(record['出貨量'].value) || 0;
        var 預約量 = parseFloat(record['預約保留量'].value) || 0;
        var 廢品量 = parseFloat(record['廢品數量'].value) || 0;
        var unit = record['商品單位'].value || '';
        var currentWhName = record['倉庫名稱'] ? record['倉庫名稱'].value : '';
        var st = getStatus(inStock, safeStock);
        var suggest = Math.max(0, safeStock - inStock);
        var invKey = record['庫存識別鍵'].value || '';
        var appId = isMobile && kintone.mobile && kintone.mobile.app
            ? kintone.mobile.app.getId()
            : kintone.app.getId();
        var recId = record.$id.value;
        var productCode = record['商品料號'] ? (record['商品料號'].value || '') : '';

        var suggestHtml = suggest > 0
            ? '<div class="inv-suggest-banner inv-suggest-warn">⚠️ 建議補貨量：<strong>' + suggest.toLocaleString() + ' ' + escapeHtml(unit) + '</strong></div>'
            : '<div class="inv-suggest-banner inv-suggest-ok">✅ 庫存量安全，無需補貨</div>';

        function miniCard(label, val, colorClass, subLabel) {
            return '<div class="inv-mini-card inv-mini-' + colorClass + '">' +
                '<div class="inv-mini-num">' + val.toLocaleString() + '</div>' +
                '<div class="inv-mini-lbl">' + escapeHtml(label) + '</div>' +
                (subLabel ? '<div class="inv-mini-sub">' + escapeHtml(subLabel) + '</div>' : '') +
                '</div>';
        }

        /* 建立進貨單：URL 只能帶頂層欄位，商品料號在採購單的子表裡，
           所以改用 localStorage 中介，於點擊當下寫入，
           採購單 App(2259) 的 create.show 需搭配讀取（見檔案末尾附的範例片段）。 */
        var purchaseNewUrl = '/k/' + CONFIG.PURCHASE_APP_ID + '/edit';
        var transferNewUrl = '/k/' + CONFIG.TRANSFER_APP_ID + '/edit';
        var listUrl = '/k/' + appId + '/'; // 直接組本 App 的一覽表 URL

        var actionsHtml =
            '<div class="inv-actions">' +
            '<a class="inv-btn inv-btn-transfer" id="inv-btn-new-purchase" href="' + purchaseNewUrl + '" target="_blank">📦 建立進貨單</a>' +
            '<a class="inv-btn inv-btn-transfer" href="' + transferNewUrl + '" target="_blank">🔄 建立調撥單</a>' +
            '<a class="inv-btn inv-btn-transfer" href="' + listUrl + '">← 回一覽表</a>' +
            '</div>';

        /* 區間統計（本月／本季／本年／累計）：進貨量／出貨量／淨增量
           🌟 這裡的「進貨量／出貨量」專指真正的採購/銷貨業務量，
              調撥視為內部倉庫間移動，刻意不計入（見 renderPeriodStats）。
              跟上面小卡片「累計入庫量／累計出庫量」（含調撥）語意不同，
              命名故意分開避免混淆，改動時請維持這個區隔。 */
        var periodHtml =
            '<div class="inv-period-box">' +
            '<div class="inv-period-head">' +
            '<span class="inv-section-title inv-period-title">區間統計（僅採購/銷貨，不含調撥）</span>' +
            '<div class="inv-period-pills">' +
            '<button class="inv-period-pill on" data-period="month">本月</button>' +
            '<button class="inv-period-pill" data-period="quarter">本季</button>' +
            '<button class="inv-period-pill" data-period="year">本年</button>' +
            '<button class="inv-period-pill" data-period="all">累計</button>' +
            '</div>' +
            '</div>' +
            '<div class="inv-period-stats">' +
            '<div class="inv-period-stat inv-period-stat-in">' +
            '<div class="inv-period-num" id="inv-period-in">—</div>' +
            '<div class="inv-period-lbl">進貨量</div>' +
            '</div>' +
            '<div class="inv-period-stat inv-period-stat-out">' +
            '<div class="inv-period-num" id="inv-period-out">—</div>' +
            '<div class="inv-period-lbl">出貨量</div>' +
            '</div>' +
            '<div class="inv-period-stat inv-period-stat-net">' +
            '<div class="inv-period-num" id="inv-period-net">—</div>' +
            '<div class="inv-period-lbl">淨增量</div>' +
            '</div>' +
            '</div>' +
            '</div>';

        /* Timeline：多包一層 .inv-timeline-scroll-wrap 來處理捲軸，保護內部的直線不斷裂 */
        var timelineHtml =
            '<style>' +
            '  .inv-timeline-scroll-wrap { max-height: 450px; overflow-y: auto; padding-right: 8px; margin-right: -8px; }' +
            '  .inv-timeline-scroll-wrap::-webkit-scrollbar { width: 6px; }' +
            '  .inv-timeline-scroll-wrap::-webkit-scrollbar-track { background: transparent; }' +
            '  .inv-timeline-scroll-wrap::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }' +
            '  .inv-timeline-scroll-wrap::-webkit-scrollbar-thumb:hover { background: #94a3b8; }' +
            '  .inv-mini-sub { font-size: 10px; color: #9ca3af; margin-top: 2px; }' +
            '</style>' +
            '<div class="inv-section-title">進出貨紀錄</div>' +
            '<div class="inv-timeline-scroll-wrap">' + // 🌟 關鍵：用這個 div 當作捲軸視窗
            '    <ul class="inv-timeline" id="inv-timeline-list">' +
            '        <li class="inv-tl-loading">載入中…</li>' +
            '    </ul>' +
            '</div>';
        var html =
            '<div id="inventory-ui">' +
            '<div class="inv-detail-header">' +
            '<div>' +
            '<div class="inv-detail-title">' + escapeHtml(record['商品名稱'].value || '—') + '</div>' +
            '<div class="inv-detail-sub">' + escapeHtml(record['商品料號'].value || '') + ' ' + escapeHtml(record['倉庫名稱'].value || '') + '</div>' +
            '</div>' +
            '<span class="inv-badge inv-badge-' + st + '">' + statusEmoji(st) + '</span>' +
            '</div>' +
            '<div class="inv-two-col">' +
            '<div class="inv-col-left">' +
            '<div class="inv-stock-num">' +
            '<div class="inv-stock-big">' + inStock.toLocaleString() + '</div>' +
            '<div class="inv-stock-label">在庫量（' + escapeHtml(unit) + '）</div>' +
            '</div>' +
            '<div class="inv-safe-row">安全庫存標準：' + safeStock.toLocaleString() + ' ' + escapeHtml(unit) + '</div>' +
            suggestHtml +
            '<div class="inv-mini-grid">' +
            miniCard('累計入庫量', 進貨量, 'blue') +
            miniCard('累計出庫量', 出貨量, 'purple') +
            miniCard('預約保留', 預約量, 'amber') +
            miniCard('廢品數量', 廢品量, 'red') +
            '</div>' +
            periodHtml +
            actionsHtml +
            '</div>' +
            '<div class="inv-col-right">' + timelineHtml + '</div>' +
            '</div>' +
            '</div>';

        var old = document.getElementById('inventory-ui');
        if (old) old.remove();
        var space = isMobile
            ? kintone.mobile.app.getHeaderSpaceElement()
            : kintone.app.record.getHeaderMenuSpaceElement();
        if (space) space.innerHTML = html;

        /* 原生欄位收合 */
        var formEl = document.querySelector('#record-gaia .layout-gaia');
        if (formEl) {
            formEl.style.display = 'none';
            var isExpanded = false;
            var uiEl = document.getElementById('inventory-ui');
            if (uiEl) {
                var toggleDiv = document.createElement('div');
                toggleDiv.id = 'inv-native-toggle';
                toggleDiv.innerHTML = '<button id="inv-toggle-btn" class="inv-toggle-btn" aria-expanded="false">▶ 展開原始欄位</button>';
                uiEl.appendChild(toggleDiv);
                document.getElementById('inv-toggle-btn').addEventListener('click', function () {
                    isExpanded = !isExpanded;
                    formEl.style.display = isExpanded ? '' : 'none';
                    this.setAttribute('aria-expanded', String(isExpanded));
                    this.textContent = isExpanded ? '▼ 收合原始欄位' : '▶ 展開原始欄位';
                });
            }
        }

        /* 建立進貨單：點擊當下把商品料號／倉庫寫入 localStorage，
           採購單 App create.show 讀取後自動清除，避免污染下一次操作 */
        var newPurchaseBtn = document.getElementById('inv-btn-new-purchase');
        if (newPurchaseBtn) {
            newPurchaseBtn.addEventListener('click', function () {
                try {
                    localStorage.setItem(CONFIG.PREFILL_CODE_KEY, productCode);
                    localStorage.setItem(CONFIG.PREFILL_WAREHOUSE_KEY, currentWhName || '');
                } catch (e) {
                    console.warn('localStorage 寫入失敗，進貨單商品料號將無法自動帶入', e);
                }
            });
        }

        /* 區間統計：切換按鈕 */
        var currentPeriod = 'month';
        var periodItemsCache = [];

        function renderPeriodStats() {
            var range = getPeriodRange(currentPeriod);
            var totalIn = 0, totalOut = 0;
            var matchedCount = 0;
            periodItemsCache.forEach(function (item) {
                if (!inRange(item.date, range)) return;
                if (item.source === 'purchase' && item.type === 'in') { totalIn += item.qty; matchedCount++; }
                if (item.source === 'sales' && item.type === 'out') { totalOut += item.qty; matchedCount++; }
            });
            var net = totalIn - totalOut;

            var inEl = document.getElementById('inv-period-in');
            var outEl = document.getElementById('inv-period-out');
            var netEl = document.getElementById('inv-period-net');
            if (inEl) inEl.textContent = totalIn.toLocaleString();
            if (outEl) outEl.textContent = totalOut.toLocaleString();
            if (netEl) {
                netEl.textContent = (net > 0 ? '+' : '') + net.toLocaleString();
                netEl.classList.remove('inv-period-net-up', 'inv-period-net-down', 'inv-period-net-flat');
                netEl.classList.add(net > 0 ? 'inv-period-net-up' : net < 0 ? 'inv-period-net-down' : 'inv-period-net-flat');
            }

            /* 診斷用：若整批資料都篩不到任何符合的進／出貨紀錄，
               在 Console 留下提示，方便確認是「本來就沒資料」還是欄位代碼對不上 */
            if (matchedCount === 0 && periodItemsCache.length > 0) {
                console.info(
                    '[庫存區間統計] 目前商品在所有進出貨紀錄中，' +
                    '沒有任何「已入庫的採購」或「已結案的銷貨」紀錄，因此進貨量／出貨量顯示為 0。' +
                    '若你確定應該要有資料，請確認採購單的「是否入庫」、銷貨單的「是否結案」欄位是否已勾選/設定。',
                    periodItemsCache
                );
            }
        }

        var periodPillsEl = document.querySelector('.inv-period-pills');
        if (periodPillsEl) {
            periodPillsEl.addEventListener('click', function (e) {
                var btn = e.target.closest('.inv-period-pill');
                if (!btn) return;
                document.querySelectorAll('.inv-period-pill').forEach(function (b) {
                    b.classList.remove('on');
                });
                btn.classList.add('on');
                currentPeriod = btn.getAttribute('data-period');
                renderPeriodStats();
            });
        }

        loadTimeline(invKey, unit, currentWhName, function (items) {
            periodItemsCache = items;
            renderPeriodStats();
        });
        return event;
    });

    /* ── Timeline 查詢（同時供區間統計重用） ──
       🌟 重要：三個查詢都必須帶「商品料號」條件，不能只靠 order by + limit
          抓「全 App 最新 N 筆」再用 JS 篩選。
          原因：隨著資料量成長，若只抓全 App 最新 N 筆，冷門商品的舊紀錄
          會被其他商品的異動擠出查詢範圍，導致 Timeline／區間統計悄悄
          漏資料且不會報錯。改成先用商品料號篩選，保證抓到的就是「這個
          商品」最新的 N 筆，不受其他商品異動量影響。 */
    function loadTimeline(invKey, unit, currentWhName, onItemsReady) {
        var list = document.getElementById('inv-timeline-list');
        if (!list) return;

        var F = CONFIG.FIELDS;
        var productCode = invKey.split('-').slice(2).join('-');
        // 🌟 子表（Table）內的欄位查詢，kintone 規定不能用 = / !=，必須用 in()/not in()
        var safeCode = String(productCode).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        var limit = CONFIG.TIMELINE_FETCH_LIMIT;
        var codeFilter = '商品料號 in ("' + safeCode + '")';
        var purchaseQuery = codeFilter + ' order by ' + F.purchase.dateField + ' desc limit ' + limit;
        var salesQuery = codeFilter + ' order by ' + F.sales.dateField + ' desc limit ' + limit;
        var transferQuery = codeFilter + ' order by ' + F.transfer.dateField + ' desc limit ' + limit;

        Promise.all([
            kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: CONFIG.PURCHASE_APP_ID, query: purchaseQuery }),
            kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: CONFIG.SALES_APP_ID, query: salesQuery }),
            kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: CONFIG.TRANSFER_APP_ID, query: transferQuery })
        ]).then(function (results) {
            var items = [];

            /* 進貨 */
            (results[0].records || []).forEach(function (r) {
                var date = r[F.purchase.dateField] ? r[F.purchase.dateField].value : '';
                var orderNo = r[F.purchase.orderNoField] ? r[F.purchase.orderNoField].value : '';
                (r[F.purchase.detailTable].value || []).forEach(function (row) {
                    var f = row.value;
                    // 1. 先比對商品料號
                    if ((f[F.purchase.codeField].value || '').trim() !== productCode) return;

                    // 2. 🌟 關鍵防呆：比對採購單的「收貨倉庫」是否等於當前畫面的「倉庫名稱」
                    var warehouse = f[F.purchase.warehouseField] ? f[F.purchase.warehouseField].value : '';
                    if (warehouse !== currentWhName) return;

                    var qty = f[F.purchase.receivedQtyField] ? parseFloat(f[F.purchase.receivedQtyField].value) || 0 : 0;
                    if (qty <= 0) return;
                    var inStatus = f[F.purchase.receivedStatusField] ? f[F.purchase.receivedStatusField].value : '';

                    items.push({
                        date: date, type: 'in', qty: qty, source: 'purchase',
                        desc: '進貨' + (inStatus ? ' (' + inStatus + ')' : '') + (orderNo ? '・' + orderNo : '') + (warehouse ? ' → ' + warehouse : '')
                    });
                });
            });

            /* 出貨 */
            (results[1].records || []).forEach(function (r) {
                var date = r[F.sales.dateField] ? r[F.sales.dateField].value : '';
                var orderNo = r[F.sales.orderNoField] ? r[F.sales.orderNoField].value : '';
                var isClosed = r[F.sales.closedField] && r[F.sales.closedField].value === F.sales.closedValue;
                var actionText = isClosed ? '已出貨' : '保留 (未結案)';
                var timelineType = isClosed ? 'out' : 'adjust';
                (r[F.sales.detailTable].value || []).forEach(function (row) {
                    var f = row.value;
                    // 1. 先比對商品料號
                    if ((f[F.sales.codeField].value || '').trim() !== productCode) return;

                    // 2. 🌟 關鍵防呆：比對銷貨單的「出貨倉庫」是否等於當前畫面的「倉庫名稱」
                    var warehouse = f[F.sales.warehouseField] ? f[F.sales.warehouseField].value : '';
                    if (warehouse !== currentWhName) return;

                    var qty = parseFloat(f[F.sales.qtyField].value) || 0;
                    if (qty <= 0) return;

                    items.push({
                        date: date, type: timelineType, qty: qty, source: 'sales',
                        desc: actionText + (orderNo ? '・' + orderNo : '') + (warehouse ? ' ← ' + warehouse : '')
                    });
                });
            });

            /* 調撥 */
            (results[2].records || []).forEach(function (r) {
                if (r[F.transfer.statusField] && r[F.transfer.statusField].value !== F.transfer.completeValue) return;
                var date = r[F.transfer.dateField] ? r[F.transfer.dateField].value : '';
                var orderNo = r[F.transfer.orderNoField] ? r[F.transfer.orderNoField].value : '';
                var transType = r[F.transfer.typeField] ? r[F.transfer.typeField].value : '常態移轉';
                var fromWh = r[F.transfer.fromField] ? r[F.transfer.fromField].value : '';
                var toWh = r[F.transfer.toField] ? r[F.transfer.toField].value : '';
                (r[F.transfer.detailTable].value || []).forEach(function (row) {
                    var f = row.value;
                    if ((f[F.transfer.codeField].value || '').trim() !== productCode) return;
                    var qty = parseFloat(f[F.transfer.qtyField].value) || 0;
                    if (qty <= 0) return;

                    if (fromWh === currentWhName)
                        items.push({
                            date: date, type: 'out', qty: qty, source: 'transfer',
                            desc: '調撥撥出 (' + transType + ')' + (orderNo ? '・' + orderNo : '') + ' ➔ ' + toWh
                        });
                    if (toWh === currentWhName)
                        items.push({
                            date: date, type: 'in', qty: qty, source: 'transfer',
                            desc: '調撥撥入 (' + transType + ')' + (orderNo ? '・' + orderNo : '') + ' ⇠ ' + fromWh
                        });
                });
            });

            items.sort(function (a, b) {
                var d = b.date.localeCompare(a.date);
                if (d !== 0) return d;
                if (a.type === 'in' && b.type !== 'in') return -1;
                if (a.type !== 'in' && b.type === 'in') return 1;
                return 0;
            });

            /* 區間統計用完整（未截斷）資料 */
            if (typeof onItemsReady === 'function') onItemsReady(items);

            if (items.length === 0) {
                list.innerHTML = '<li class="inv-tl-empty">尚無此商品的進出貨紀錄</li>';
                return;
            }

            var displayItems = items.slice(0, CONFIG.TIMELINE_DISPLAY_LIMIT);

            list.innerHTML = displayItems.map(function (item) {
                var sign = item.type === 'in' ? '+' : '−';
                return '<li class="inv-tl-item">' +
                    '<div class="inv-tl-dot inv-tl-dot-' + item.type + '"></div>' +
                    '<div class="inv-tl-date">' + escapeHtml(item.date || '—') + '</div>' +
                    '<div class="inv-tl-row">' +
                    '<span class="inv-tl-desc">' + escapeHtml(item.desc) + '</span>' +
                    '<span class="inv-tl-qty inv-tl-qty-' + item.type + '">' + sign + item.qty.toLocaleString() + ' ' + escapeHtml(unit) + '</span>' +
                    '</div></li>';
            }).join('');

        }).catch(function (err) {
            console.error('Timeline 載入失敗:', err);
            list.innerHTML = '<li class="inv-tl-empty">進出貨紀錄載入失敗，請確認 App 權限設定。</li>';
            if (typeof onItemsReady === 'function') onItemsReady([]);
        });
    }

})();

/* ═══════════════════════════════════════════════
   【附】採購單 App (2259) 需要搭配加入的片段
   放到採購單自己的 JS customize 檔案裡（create.show）
   作用：讀取本檔案透過 localStorage 寫入的商品料號／倉庫，
        自動帶入「採購內容」子表的第一列
   ═══════════════════════════════════════════════

(function () {
    'use strict';
    kintone.events.on('app.record.create.show', function (event) {
        var code = null, wh = null;
        try {
            code = localStorage.getItem('inv_prefill_商品料號');
            wh   = localStorage.getItem('inv_prefill_收貨倉庫');
        } catch (e) { return event; }

        if (!code) return event;

        var table = event.record['採購內容'].value;
        if (table.length === 0) {
            // 依你的子表列結構，用 kintone.app.record.createSubtableRow 或
            // 直接建立一個空 row 物件後 push，這裡假設既有預設一列可用
        }
        if (table.length > 0 && !table[0].value['商品料號'].value) {
            table[0].value['商品料號'].value = code;
            if (wh && table[0].value['收貨倉庫']) {
                table[0].value['收貨倉庫'].value = wh;
            }
        }

        try {
            localStorage.removeItem('inv_prefill_商品料號');
            localStorage.removeItem('inv_prefill_收貨倉庫');
        } catch (e) {}

        return event;
    });
})();

═══════════════════════════════════════════════ */
