(function () {
    'use strict';

    /* ═══════════════════════════════════════════════
       應收帳款 App - receivable.js
       功能：
         1. 從銷貨單拋轉時，自動帶入子表格列
         2. 客戶名稱變更時，自動查詢未結案銷貨單填入子表格
         3. 儲存成功後，「已全額收訖」→ 回寫銷貨單「已立帳核銷」+ 智慧日期
         4. 勾選「已入帳」→ 自動核銷子表格所有明細
       ═══════════════════════════════════════════════ */

    // =======================================================================
    //  ⚙️ 系統參數與欄位代碼
    // =======================================================================
    const SALES_APP_ID = 17;

    // 【應收帳款 App 欄位代碼】
    const AR_HEADER_SALES_NUM = '銷貨出庫單號';
    const AR_CUSTOMER_FIELD = '客戶名稱';
    const AR_PAY_STATUS = '收款狀態';
    const AR_SUBTABLE = '應收表';
    const AR_SUB_SALES_NUM = '明細出貨單號';

    // 【銷貨單 App 欄位代碼】
    const SALES_CUSTOMER_FIELD = '客戶名稱';
    const SALES_NUM_FIELD = '銷貨單號';
    const SALES_STATUS_FIELD = '立帳狀態';
    const SALES_DATE_FIELD = '完成核銷日期';

    // ── 自動編號外掛鎖定欄位 ─────────────────────────────────────────
    // 🌟 此欄位由「ERP 自動編號外掛」在 app.record.edit.show 時設為 disabled=true。
    //    本檔案內多處使用 kintone.app.record.set() 整頁重繪畫面
    //    （包含 500ms 輪詢的 customerWatcher），
    //    kintone 並不保證重繪後會保留先前程式碼設定的 disabled 狀態，
    //    因此每次呼叫 record.set() 之前，都必須手動重新鎖定，
    //    否則使用者會發現欄位在資料重新帶入後突然變成可編輯。
    const LOCKED_AR_NUM_FIELD = '應收帳款單號';

    let customerWatcher = null;
    let pageLoadPayStatus = ''; // 記住畫面打開時的收款狀態，防重複回寫

    // =======================================================================
    //  Toast 工具
    // =======================================================================
    const TOAST_STYLES = {
        success: { bg: '#f0fdf4', border: '#86efac', text: '#15803d', icon: '✓' },
        error: { bg: '#fef2f2', border: '#fca5a5', text: '#dc2626', icon: '✕' },
        warn: { bg: '#fffbeb', border: '#fde68a', text: '#d97706', icon: '⚠' },
        info: { bg: '#eff6ff', border: '#93c5fd', text: '#2563eb', icon: 'ℹ' },
    };
    let _toastEl = null;

    function showToast(message, type, duration) {
        type = type || 'info';
        duration = duration === undefined ? 3000 : duration;
        if (_toastEl) { _toastEl.remove(); _toastEl = null; }
        const s = TOAST_STYLES[type] || TOAST_STYLES.info;
        const toast = document.createElement('div');
        Object.assign(toast.style, {
            position: 'fixed', top: '20px', left: '50%',
            transform: 'translateX(-50%) translateY(-16px)',
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '13px 20px', background: s.bg,
            border: `1.5px solid ${s.border}`, borderRadius: '10px',
            color: s.text, fontWeight: '600', fontSize: '14px',
            fontFamily: "'Segoe UI','Noto Sans TC',system-ui,sans-serif",
            boxShadow: '0 6px 24px rgba(0,0,0,.13)', zIndex: '99999',
            opacity: '0', transition: 'all .25s cubic-bezier(.34,1.56,.64,1)',
            whiteSpace: 'nowrap', pointerEvents: 'none', maxWidth: 'calc(100vw - 32px)',
        });
        const icon = document.createElement('span');
        icon.textContent = s.icon; icon.style.fontSize = '16px';
        const text = document.createElement('span');
        text.textContent = message;
        toast.append(icon, text);
        document.body.appendChild(toast);
        _toastEl = toast;
        requestAnimationFrame(() => {
            Object.assign(toast.style, { opacity: '1', transform: 'translateX(-50%) translateY(0)' });
        });
        if (duration > 0) {
            setTimeout(() => {
                Object.assign(toast.style, { opacity: '0', transform: 'translateX(-50%) translateY(-10px)' });
                setTimeout(() => { toast.remove(); if (_toastEl === toast) _toastEl = null; }, 280);
            }, duration);
        }
    }

    // =======================================================================
    //  🔒 鎖定保護工具
    // =======================================================================
    //  每次要用 kintone.app.record.set() 整頁重繪前，先呼叫這個函式，
    //  確保自動編號外掛鎖定的欄位不會因為重繪而被解鎖。

    function reapplyLock(record) {
        if (record[LOCKED_AR_NUM_FIELD]) {
            record[LOCKED_AR_NUM_FIELD].disabled = true;
        }
    }

    // =======================================================================
    //  工具：建立子表格新列（只設 Lookup 來源欄位，其餘讓 Lookup 帶入）
    // =======================================================================
    function createNewRow(salesNum) {
        return {
            value: {
                [AR_SUB_SALES_NUM]: {
                    type: 'SINGLE_LINE_TEXT', value: salesNum,
                    lookup: true
                }
            }
        };
    }

    // =======================================================================
    //  工具：查詢銷貨單並回傳子表格列陣列
    // =======================================================================
    function fetchAndBuildRows(query) {
        return kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
            app: SALES_APP_ID, query,
        }).then(resp => resp.records.map(r => createNewRow(r[SALES_NUM_FIELD].value)));
    }

    // =======================================================================
    //  工具：智慧日期判定
    // =======================================================================
    function resolveCompletedDate(record) {
    const getVal = field => {
        if (!record[field] || !record[field].value) return '';
        if (Array.isArray(record[field].value)) return record[field].value.join(',');
        return String(record[field].value).trim();
    };

    const payMethod = getVal('收款方式');
    let date = '';

    if (payMethod.includes('支票')) {
        date = getVal('支票預兌日期');
    } else if (payMethod) {
        date = getVal('收款日期');
    }

    if (!date) date = getVal('立帳日期');
    if (date) return date;

    const sysCreated = record['建立時間']?.value;
    if (sysCreated) return sysCreated.split('T')[0];

    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

    // =======================================================================
    //  事件一：進入畫面
    // =======================================================================
    kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {
        const record = event.record;

        // 記住打開畫面時的收款狀態，防止重複回寫
        pageLoadPayStatus = record[AR_PAY_STATUS]?.value || '';

        // 新增時：從銷貨單拋轉，自動帶入第一筆子表格列
        if (event.type === 'app.record.create.show') {
            const headerSalesNum = record[AR_HEADER_SALES_NUM]?.value;
            if (headerSalesNum) {
                fetchAndBuildRows(`${SALES_NUM_FIELD} = "${headerSalesNum}"`)
                    .then(rows => {
                        const rec = kintone.app.record.get();
                        if (!rec) return;
                        rec.record[AR_SUBTABLE].value = rows;
                        reapplyLock(rec.record); // 🔒 重繪前重新鎖定，避免自動編號欄位被解鎖
                        kintone.app.record.set(rec);
                    })
                    .catch(err => {
                        console.error('[應收] 拋轉銷貨單失敗:', err);
                        showToast('⚠️ 載入銷貨單資料失敗，請手動填寫。', 'warn');
                    });
            }
        }

        // 客戶名稱巡邏員：每 500ms 偵測客戶是否變更，自動重建子表格
        let lastCustomer = record[AR_CUSTOMER_FIELD]?.value || '';
        if (customerWatcher) clearInterval(customerWatcher);

        customerWatcher = setInterval(() => {
            const recObj = kintone.app.record.get();
            if (!recObj) return;

            const currentCustomer = recObj.record[AR_CUSTOMER_FIELD]?.value || '';
            if (currentCustomer === lastCustomer) return;
            lastCustomer = currentCustomer;

            if (!currentCustomer) {
                recObj.record[AR_SUBTABLE].value = [];
                reapplyLock(recObj.record); // 🔒 重繪前重新鎖定，避免自動編號欄位被解鎖
                kintone.app.record.set(recObj);
                return;
            }

            const query = `${SALES_CUSTOMER_FIELD} = "${currentCustomer}" and ${SALES_STATUS_FIELD} not in ("已立帳核銷")`;
            fetchAndBuildRows(query)
                .then(rows => {
                    const latest = kintone.app.record.get();
                    if (!latest) return;
                    if (rows.length === 0) {
                        showToast(`🎉 【${currentCustomer}】目前沒有任何未收款的銷貨單！`, 'success');
                        latest.record[AR_SUBTABLE].value = [];
                    } else {
                        latest.record[AR_SUBTABLE].value = rows;
                    }
                    reapplyLock(latest.record); // 🔒 重繪前重新鎖定，避免自動編號欄位被解鎖
                    kintone.app.record.set(latest);
                })
                .catch(err => console.error('[應收] 查詢未結銷貨單失敗:', err));
        }, 500);

        return event;
    });

    // =======================================================================
    //  事件二：儲存 / 離開 → 停止巡邏員
    // =======================================================================
    kintone.events.on([
        'app.record.create.submit', 'app.record.edit.submit',
        'app.record.create.submit.success', 'app.record.edit.submit.success',
    ], function (event) {
        if (customerWatcher) { clearInterval(customerWatcher); customerWatcher = null; }
        return event;
    });

    // =======================================================================
    //  事件三：儲存成功 → 「已全額收訖」回寫銷貨單「已立帳核銷」+ 智慧日期
    // =======================================================================
    kintone.events.on([
        'app.record.create.submit.success',
        'app.record.edit.submit.success',
    ], function (event) {
        const record = event.record;
        const isNew = event.type === 'app.record.create.submit.success';

        // 不是已全額收訖，跳過
        if (record[AR_PAY_STATUS]?.value !== '已全額收訖') return event;

        // 編輯時，若畫面打開就已經是「已全額收訖」，代表這次只是修改其他欄位，跳過避免重複回寫
        if (!isNew && pageLoadPayStatus === '已全額收訖') return event;

        const salesNumbers = [];
        record[AR_SUBTABLE].value.forEach(row => {
            const num = row.value[AR_SUB_SALES_NUM]?.value;
            if (num && !salesNumbers.includes(num)) salesNumbers.push(num);
        });
        if (!salesNumbers.length) return event;

        const completedDate = resolveCompletedDate(record);

        return kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
            app: SALES_APP_ID,
            query: `${SALES_NUM_FIELD} in ("${salesNumbers.join('","')}")`,
        }).then(resp => {
            const updates = resp.records.map(r => ({
                id: r.$id.value,
                record: {
                    [SALES_STATUS_FIELD]: { value: ['已立帳核銷'] },
                    [SALES_DATE_FIELD]: { value: completedDate },
                },
            }));
            if (!updates.length) return event;
            return kintone.api(kintone.api.url('/k/v1/records', true), 'PUT', {
                app: SALES_APP_ID, records: updates,
            }).then(() => event);
        }).catch(err => {
            console.error('[應收] 核銷連動失敗:', err);
            return event;
        });
    });

    // =======================================================================
    //  事件四：勾選「已入帳」→ 自動核銷子表格所有明細
    // =======================================================================
    kintone.events.on([
        'app.record.create.change.帳務狀態',
        'app.record.edit.change.帳務狀態',
    ], function (event) {
        const record = event.record;
        const statusValues = record['帳務狀態']?.value || [];

        if (statusValues.includes('已入帳')) {
            let isChanged = false;
            record[AR_SUBTABLE].value.forEach(row => {
                if (row.value['核銷狀態'] && !row.value['核銷狀態'].value.includes('已核銷')) {
                    row.value['核銷狀態'].value = ['已核銷'];
                    isChanged = true;
                }
            });
            if (isChanged) showToast('✅ 已自動將所有明細標記為「已核銷」！', 'success');
        }
        return event;
    });

})();