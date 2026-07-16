(function () {
    'use strict';

    /* ═══════════════════════════════════════════════
       庫存總表（index view）專用 inventory-index.js
       功能：倉庫下拉選單、狀態篩選、欄位排序、點列跳詳情
       ═══════════════════════════════════════════════ */

    /* ═══════════════════════════════════════════════
   ⚠️ 套用到新環境／新 App 前，請確認以下設定：
 
   🔧 1. TARGET_VIEW_ID（下方）
         要顯示這個庫存面板的「一覽」視圖 ID。
         去 App 設定 → 一覽 → 該視圖 → 網址列的數字就是 viewId。
         PC／手機若各自有獨立視圖，兩邊的 ID 要一併確認。
 
   🔧 2. 下面用到的欄位代碼（散落在 renderTable／CSV 匯出裡）：
         倉庫名稱、在庫量、安全庫存量、商品料號、商品名稱、商品單位
         如果拿去套用在別的 App，要逐一比對欄位代碼是否一致。
 
   ✅ appId 是用 kintone.app.getId() 自動取得，不用改。
   ═══════════════════════════════════════════════ */

    var TARGET_VIEW_ID = 11217235;

    /* ─────────────────────────────────────────────
       共用工具
       ───────────────────────────────────────────── */

    function getStatus(inStock, safeStock) {
        if (inStock <= 0) return 'empty';
        if (inStock < safeStock) return 'low';
        return 'ok';
    }

    function statusLabel(s) {
        return s === 'empty' ? '缺貨' : s === 'low' ? '低庫存' : '正常';
    }

    function statusOrder(s) {
        return s === 'empty' ? 0 : s === 'low' ? 1 : 2;
    }

    function escapeHtml(str) {
        return (str || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function statCard(count, label, color) {
        return '<div class="inv-stat">' +
            '<div class="inv-stat-n" style="color:' + color + ';">' + count + '</div>' +
            '<div class="inv-stat-l">' + escapeHtml(label) + '</div>' +
            '</div>';
    }

    /* PC／手機共用的插入點取得：PC 用 kintone.app，
       手機用 kintone.mobile.app，兩者的 header space API 不同 */
    function getHeaderSpace() {
        if (kintone.app && typeof kintone.app.getHeaderSpaceElement === 'function') {
            var pcSpace = kintone.app.getHeaderSpaceElement();
            if (pcSpace) return pcSpace;
        }
        if (typeof kintone !== 'undefined' && kintone.mobile &&
            kintone.mobile.app && typeof kintone.mobile.app.getHeaderSpaceElement === 'function') {
            return kintone.mobile.app.getHeaderSpaceElement();
        }
        return null;
    }

    /* ─────────────────────────────────────────────
       清單頁面
       ───────────────────────────────────────────── */

    kintone.events.on(['app.record.index.show', 'mobile.app.record.index.show'], function (event) {
        var isMobile = event.type === 'mobile.app.record.index.show';

        // 🔧 viewId 用 String() 轉型比較，避免手機端回傳型別不同(number vs string)導致比對失敗
        if (String(event.viewId) !== String(TARGET_VIEW_ID)) return event;

        var records = event.records || [];
        var appId = isMobile && kintone.mobile && kintone.mobile.app
            ? kintone.mobile.app.getId()
            : kintone.app.getId();


        /* ── records → 倉庫別資料 ──
           🔧 [需依環境修改] 以下 6 個欄位代碼都對應到目前這個庫存 App，
              換 App 使用時要逐一核對是否同名。 */
        var warehouseMap = {};
        records.forEach(function (r) {
            var wName = r['倉庫名稱'].value || '未命名倉庫';
            var inStock = parseFloat(r['在庫量'].value) || 0;
            var safeStock = parseFloat(r['安全庫存量'].value) || 0;

            if (!warehouseMap[wName]) warehouseMap[wName] = [];
            warehouseMap[wName].push({
                id: r.$id.value,
                code: r['商品料號'].value || '',
                name: r['商品名稱'].value || '（未命名）',
                unit: r['商品單位'].value || '',
                in: inStock,
                safe: safeStock,
                status: getStatus(inStock, safeStock)
            });
        });

        var warehouseNames = Object.keys(warehouseMap).sort();
        if (warehouseNames.length === 0) return event;

        /* ── 建構 HTML ── */
        var ALL_KEY = '__ALL__';  // 全部倉庫的特殊 key

        /* 把所有倉庫的商品合併成一個 flat list，加上倉庫名稱欄位 */
        var allItems = [];
        warehouseNames.forEach(function (w) {
            warehouseMap[w].forEach(function (item) {
                allItems.push(Object.assign({}, item, { warehouse: w }));
            });
        });
        warehouseMap[ALL_KEY] = allItems;

        /* 全部倉庫 option 排在第一位 */
        var warehouseOptions =
            '<option value="' + ALL_KEY + '">── 全部倉庫 ──</option>' +
            warehouseNames.map(function (w) {
                return '<option value="' + escapeHtml(w) + '">' + escapeHtml(w) + '</option>';
            }).join('');

        var html =
            '<div id="inv-dashboard">' +
            '<div id="inv-ctrl">' +
            '<select id="inv-wh-sel" aria-label="選擇倉庫">' + warehouseOptions + '</select>' +
            '<div class="inv-pills">' +
            '<button class="inv-pill on-all" data-f="all">全部</button>' +
            '<button class="inv-pill"        data-f="ok">正常</button>' +
            '<button class="inv-pill"        data-f="low">低庫存</button>' +
            '<button class="inv-pill"        data-f="empty">缺貨</button>' +
            '</div>' +
            '<button id="inv-csv-btn" class="inv-csv-btn" title="匯出目前檢視為 CSV">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
            ' CSV' +
            '</button>' +
            '</div>' +
            '<div id="inv-stat-row"></div>' +
            (isMobile
                ? '<div id="inv-card-list"></div>'
                :
                '<div id="inv-tbl-wrap">' +
                '<table id="inv-tbl">' +
                '<colgroup id="inv-colgroup"></colgroup>' +
                '<thead><tr id="inv-thead-row">' +
                '<th></th>' +
                '<th data-col="name">商品名稱 <span class="sort-icon">↕</span></th>' +
                '<th data-col="warehouse" class="inv-col-wh-hdr" style="display:none;">倉庫 <span class="sort-icon">↕</span></th>' +
                '<th data-col="code">料號 <span class="sort-icon">↕</span></th>' +
                '<th data-col="in" class="num-col">在庫量 <span class="sort-icon">↕</span></th>' +
                '<th data-col="safe" class="num-col">安全庫存 <span class="sort-icon">↕</span></th>' +
                '<th data-col="suggest" class="num-col">建議補貨量 <span class="sort-icon">↕</span></th>' +
                '<th data-col="status" class="center-col">狀態 <span class="sort-icon">↕</span></th>' +
                '</tr></thead>' +
                '<tbody id="inv-tbl-body"></tbody>' +
                '</table>' +
                '</div>'
            ) +
            '</div>';

        /* ── 插入 DOM ──
           PC 用 getHeaderSpaceElement()（header 按鈕列下方，寬度撐滿頁面），
           手機用 kintone.mobile.app.getHeaderSpaceElement()，
           兩者都拿不到就放棄渲染（例如未來 kintone SDK 版本異動）。
        ── */
        var old = document.getElementById('inv-dashboard');
        if (old) old.remove();
        var space = getHeaderSpace();
        if (!space) return event;
        space.innerHTML = html;

        /* ── 狀態 ── */
        var currentFilter = 'all';
        var sortCol = 'status';
        var sortDir = 1;

        /* ── 渲染 ── */
        function renderTable() {
            var wName = document.getElementById('inv-wh-sel').value;
            var isAll = wName === ALL_KEY;
            var items = warehouseMap[wName] || [];

            /* 統計卡：桌面/手機共用 */
            var total = items.length;
            var ok = items.filter(function (i) { return i.status === 'ok'; }).length;
            var low = items.filter(function (i) { return i.status === 'low'; }).length;
            var empty = items.filter(function (i) { return i.status === 'empty'; }).length;
            var totalLabel = isAll ? '庫存記錄' : '商品種類';

            document.getElementById('inv-stat-row').innerHTML =
                statCard(total, totalLabel, '#374151') +
                statCard(ok, '正常', '#3B6D11') +
                statCard(low, '低庫存', '#854F0B') +
                statCard(empty, '缺貨', '#A32D2D');

            /* 排序：桌面/手機共用 */
            var sorted = items.slice().sort(function (a, b) {
                var diff;
                switch (sortCol) {
                    case 'status': diff = statusOrder(a.status) - statusOrder(b.status); break;
                    case 'name': diff = a.name.localeCompare(b.name, 'zh-TW'); break;
                    case 'code': diff = a.code.localeCompare(b.code); break;
                    case 'warehouse': diff = (a.warehouse || '').localeCompare(b.warehouse || '', 'zh-TW'); break;
                    case 'in': diff = a.in - b.in; break;
                    case 'safe': diff = a.safe - b.safe; break;
                    case 'suggest': diff = (a.safe - a.in) - (b.safe - b.in); break;
                    default: diff = 0;
                }
                return diff * sortDir;
            });

            /* 🔧 手機分支：渲染卡片，直接 return，不跑下面桌面版表格邏輯 */
            if (isMobile) {
                var listEl = document.getElementById('inv-card-list');
                var visibleItems = sorted.filter(function (i) {
                    return currentFilter === 'all' || i.status === currentFilter;
                });
                listEl.innerHTML = visibleItems.length
                    ? visibleItems.map(function (item) { return cardHtml(item, isAll); }).join('')
                    : '<div class="inv-card-list-empty">此篩選條件下沒有商品</div>';
                return;
            }

            /* ↓↓↓ 以下維持原本桌面版邏輯（colgroup / 倉庫欄顯示隱藏 / tbody / 排序圖示）不變 ↓↓↓ */
            var colgroup = document.getElementById('inv-colgroup');
            if (colgroup) {
                colgroup.innerHTML = isAll
                    ? '<col style="width:20px;"><col style="width:24%;"><col style="width:11%;"><col style="width:13%;"><col style="width:10%;"><col style="width:10%;"><col style="width:13%;"><col style="width:10%;">'
                    : '<col style="width:20px;"><col style="width:28%;"><col style="width:15%;"><col style="width:12%;"><col style="width:12%;"><col style="width:15%;"><col style="width:11%;">';
            }

            var whHdr = document.querySelector('.inv-col-wh-hdr');
            if (whHdr) whHdr.style.display = isAll ? '' : 'none';
            document.querySelectorAll('.inv-col-wh').forEach(function (el) {
                el.style.display = isAll ? '' : 'none';
            });

            var tbody = document.getElementById('inv-tbl-body');
            var visible = 0;
            var colspan = isAll ? 8 : 7;

            tbody.innerHTML = sorted.map(function (item) {
                var show = currentFilter === 'all' || item.status === currentFilter;
                if (show) visible++;
                var suggest = Math.max(0, item.safe - item.in);
                var suggestHtml = suggest > 0
                    ? '<span class="inv-suggest-num">' + suggest.toLocaleString() + ' <span class="inv-unit">' + escapeHtml(item.unit) + '</span></span>'
                    : '<span class="inv-suggest-zero">—</span>';
                var detailUrl = '/k/' + appId + '/show#record=' + item.id;
                var rowClass = show ? 'inv-row-' + item.status : 'inv-row-hidden';

                return '<tr data-href="' + detailUrl + '" data-status="' + item.status + '" class="' + rowClass + '">' +
                    '<td><span class="inv-light inv-light-' + item.status + '"></span></td>' +
                    '<td class="inv-col-name">' + escapeHtml(item.name) + '</td>' +
                    '<td class="inv-col-wh inv-col-code" style="' + (isAll ? '' : 'display:none;') + '">' + escapeHtml(item.warehouse || '') + '</td>' +
                    '<td class="inv-col-code">' + escapeHtml(item.code) + '</td>' +
                    '<td class="inv-col-num">' + item.in.toLocaleString() + ' <span class="inv-unit">' + escapeHtml(item.unit) + '</span></td>' +
                    '<td class="inv-col-safe">' + item.safe.toLocaleString() + '</td>' +
                    '<td class="inv-col-num">' + suggestHtml + '</td>' +
                    '<td class="inv-col-center"><span class="inv-badge inv-badge-' + item.status + '">' +
                    statusLabel(item.status) + '</span></td>' +
                    '</tr>';
            }).join('');

            if (visible === 0) {
                tbody.innerHTML = '<tr class="inv-empty-row"><td colspan="' + colspan + '">此篩選條件下沒有商品</td></tr>';
            }

            document.querySelectorAll('#inv-tbl th[data-col]').forEach(function (th) {
                var col = th.getAttribute('data-col');
                var icon = th.querySelector('.sort-icon');
                th.classList.toggle('sorted', col === sortCol);
                if (icon) icon.textContent = col === sortCol ? (sortDir === 1 ? '↑' : '↓') : '↕';
            });
        }

        function cardHtml(item, isAll) {
            var suggest = Math.max(0, item.safe - item.in);
            var suggestHtml = suggest > 0
                ? '<span class="inv-suggest-num">' + suggest.toLocaleString() + ' ' + escapeHtml(item.unit) + '</span>'
                : '<span class="inv-suggest-zero">—</span>';
            var detailUrl = '/k/' + appId + '/show#record=' + item.id;

            return '<div class="inv-card inv-card-' + item.status + '" data-href="' + detailUrl + '">' +
                '<div class="inv-card-top">' +
                '<div class="inv-card-name">' + escapeHtml(item.name) + '</div>' +
                '<span class="inv-badge inv-badge-' + item.status + '">' + statusLabel(item.status) + '</span>' +
                '</div>' +
                '<div class="inv-card-sub">' + escapeHtml(item.code) +
                (isAll ? ' · ' + escapeHtml(item.warehouse || '') : '') + '</div>' +
                '<div class="inv-card-stats">' +
                '<div class="inv-card-stat"><span class="l">在庫量</span><span class="v">' + item.in.toLocaleString() + ' ' + escapeHtml(item.unit) + '</span></div>' +
                '<div class="inv-card-stat"><span class="l">安全庫存</span><span class="v">' + item.safe.toLocaleString() + '</span></div>' +
                '<div class="inv-card-stat"><span class="l">建議補貨</span><span class="v">' + suggestHtml + '</span></div>' +
                '</div>' +
                '</div>';
        }

        /* ── 事件綁定 ── */
        document.getElementById('inv-wh-sel').addEventListener('change', renderTable);

        document.getElementById('inv-dashboard').addEventListener('click', function (e) {
            var pill = e.target.closest('.inv-pill');
            if (pill) {
                currentFilter = pill.getAttribute('data-f');
                document.querySelectorAll('#inv-dashboard .inv-pill').forEach(function (b) {
                    b.className = 'inv-pill';
                });
                pill.classList.add('on-' + currentFilter);
                renderTable();
                return;
            }

            var th = e.target.closest('th[data-col]');
            if (th) {
                var col = th.getAttribute('data-col');
                sortDir = (sortCol === col) ? sortDir * -1 : 1;
                sortCol = col;
                renderTable();
                return;
            }

            /* 🔧 新增：手機卡片點擊跳轉詳情 */
            var card = e.target.closest('.inv-card[data-href]');
            if (card) {
                window.location.href = card.getAttribute('data-href');
                return;
            }

            var tr = e.target.closest('tr[data-href]');
            if (tr) {
                window.location.href = tr.getAttribute('data-href');
            }
        });

        /* ── CSV 匯出 ── */
        document.getElementById('inv-csv-btn').addEventListener('click', function () {
            var wName = document.getElementById('inv-wh-sel').value;
            var isAll = wName === ALL_KEY;
            var items = warehouseMap[wName] || [];
            var filter = currentFilter;
            var visible = items.filter(function (i) {
                return filter === 'all' || i.status === filter;
            });

            var headers = isAll
                ? ['商品名稱', '倉庫', '料號', '在庫量', '單位', '安全庫存', '建議補貨量', '狀態']
                : ['商品名稱', '料號', '在庫量', '單位', '安全庫存', '建議補貨量', '狀態'];

            var statusMap = { ok: '正常', low: '低庫存', empty: '缺貨' };

            var rows = visible.map(function (item) {
                var suggest = Math.max(0, item.safe - item.in);
                var base = [
                    '"' + item.name.replace(/"/g, '""') + '"',
                ];
                if (isAll) base.push('"' + (item.warehouse || '').replace(/"/g, '""') + '"');
                base = base.concat([
                    '"' + item.code.replace(/"/g, '""') + '"',
                    item.in,
                    '"' + item.unit + '"',
                    item.safe,
                    suggest,
                    '"' + (statusMap[item.status] || item.status) + '"'
                ]);
                return base.join(',');
            });

            var csv = '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
            var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            var whLabel = isAll ? '全部倉庫' : wName;
            a.href = url;
            a.download = '庫存_' + whLabel + '_' + new Date().toISOString().slice(0, 10) + '.csv';
            a.click();
            URL.revokeObjectURL(url);
        });

        renderTable();
        return event;
    });

})();