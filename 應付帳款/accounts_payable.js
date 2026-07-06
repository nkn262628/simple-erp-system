(function () {
    'use strict';

    console.log('%c[AP] accounts_payable.js 載入 — 版本標記：v-copy-clear-004', 'background:#222;color:#0f0;font-weight:bold;padding:2px 6px;');

    /* ═══════════════════════════════════════════════════════════════
       4-1 應付帳款 App - accounts_payable.js - 功能整合版（含單號鎖定 + 複製防呆）
       ═══════════════════════════════════════════════════════════════ */

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  ⚠️  部署前必讀：以下數值請依實際環境手動確認後再上線       ║
    // ╠══════════════════════════════════════════════════════════════╣
    // ║  App ID：kintone 後台 > 應用程式設定 > URL 末段數字         ║
    // ║  欄位代碼：欄位設定 > 欄位代碼（非欄位名稱）                ║
    // ╚══════════════════════════════════════════════════════════════╝

    // ── App ID ───────────────────────────────────────────────────────
    const VENDOR_APP_ID = 2282;   // 0-3 廠商資料
    const PO_APP_ID = 2287;   // 2-1 採購進貨單

    // ── 應付帳款欄位代碼 ─────────────────────────────────────────────
    const AP_VENDOR_CODE = '廠商代號';
    const AP_VENDOR_FIELD = '廠商名稱';
    const AP_PAY_STATUS = '付款狀態';
    const AP_PAY_METHOD = '付款方式';
    const AP_CHEQUE_DATE = '預兌日期';
    const AP_PAY_DATE = '付款日期';
    const AP_CREATE_DATE = '立帳日期';
    const AP_DISCOUNT_IN = '本次折讓金額';
    const AP_SUBTABLE = '應付表';
    const AP_SUB_PO_NUM = '明細進貨單號';
    const AP_HEADER_PO_NUM = '採購進貨單號';
    const LOCKED_AP_NUM_FIELD = '應付帳款單號';   // 🔒 需鎖定、且複製時要清空的單號欄位

    // ── 採購進貨單欄位代碼 ───────────────────────────────────────────
    const PO_NUM_FIELD = '採購單號';
    const PO_VENDOR_FIELD = '廠商名稱';
    const PO_STATUS_FIELD = '立帳狀態';
    const PO_PAY_DATE_FIELD = '帳單已完成支付作業日期';

    // ── 廠商折讓狀態（模組層級變數） ─────────────────────────────────
    let currentVendorRecordId = null;
    let currentBalance = 0;
    let pageLoadPayStatus = '';
    let rowTemplate = null;

    // ══════════════════════════════════════════════════════════════════
    //  🔒 鎖定保護工具
    // ══════════════════════════════════════════════════════════════════
    //  「ERP 自動編號外掛」只在 app.record.edit.show 當下設一次
    //  disabled = true。本檔案之後多處會用 kintone.app.record.set()
    //  整包覆寫畫面（廠商代號變更帶入子表格、表頭進貨單拋轉等），
    //  每次覆寫前都必須手動重新鎖定，否則欄位會在資料重新帶入後
    //  變回可編輯。禁止用 setInterval 巡邏，會跟這些非同步查詢
    //  互搶 get()/set()，造成資料帶入被覆蓋掉。

    function reapplyLock(record) {
        if (record && record[LOCKED_AP_NUM_FIELD]) {
            record[LOCKED_AP_NUM_FIELD].disabled = true;
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  Toast 工具 (已拔除 Loading 動畫)
    // ══════════════════════════════════════════════════════════════════

    const TOAST_STYLES = {
        success: { bg: '#f0fdf4', border: '#86efac', text: '#15803d', icon: '✓' },
        error: { bg: '#fef2f2', border: '#fca5a5', text: '#dc2626', icon: '✕' },
        warn: { bg: '#fffbeb', border: '#fde68a', text: '#d97706', icon: '⚠' },
        info: { bg: '#eff6ff', border: '#93c5fd', text: '#2563eb', icon: 'ℹ' },
    };
    let _toastEl = null;

    function showToast(message, type = 'info', duration = 3000) {
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
        icon.textContent = s.icon;
        icon.style.fontSize = '16px';

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
        return toast;
    }

    // ══════════════════════════════════════════════════════════════════
    //  廠商折讓查詢（同步 XHR）
    // ══════════════════════════════════════════════════════════════════

    function fetchVendorDiscount(vendorCode) {
        if (!vendorCode) return null;
        const url = kintone.api.url('/k/v1/records', true)
            + '?app=' + VENDOR_APP_ID
            + '&query=' + encodeURIComponent('廠商代號 = "' + vendorCode + '" limit 1')
            + '&fields[]=' + encodeURIComponent('折讓餘額')
            + '&fields[]=$id';
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        xhr.send(null);
        if (xhr.status !== 200) return null;
        const resp = JSON.parse(xhr.responseText);
        if (!resp.records || !resp.records.length) return null;
        return {
            id: resp.records[0]['$id'].value,
            balance: parseFloat(resp.records[0]['折讓餘額'].value) || 0,
        };
    }

    function loadVendorDiscount(vendorCode) {
        if (!vendorCode) {
            currentVendorRecordId = null;
            currentBalance = 0;
            return;
        }
        const result = fetchVendorDiscount(vendorCode);
        if (result) {
            currentVendorRecordId = result.id;
            currentBalance = result.balance;
        } else {
            currentVendorRecordId = null;
            currentBalance = 0;
        }
    }

    function updateDiscountHint(record) {
        const inputVal = parseFloat(record[AP_DISCOUNT_IN].value) || 0;
        if (!currentVendorRecordId) {
            record[AP_DISCOUNT_IN].error = null;
            return;
        }
        record[AP_DISCOUNT_IN].error = inputVal > currentBalance
            ? `❌ 超過可用折讓餘額！目前剩餘：${currentBalance.toLocaleString()} 元`
            : `💡 目前可用折讓餘額：${currentBalance.toLocaleString()} 元`;
    }

    // ══════════════════════════════════════════════════════════════════
    //  子表格工具
    // ══════════════════════════════════════════════════════════════════

    function captureRowTemplate(record) {
        if (!rowTemplate && record[AP_SUBTABLE].value.length > 0) {
            rowTemplate = JSON.parse(JSON.stringify(record[AP_SUBTABLE].value[0].value));
        }
    }

    function createSubRow(poNum) {
        const row = {};
        if (rowTemplate) {
            for (const key in rowTemplate) {
                row[key] = { type: rowTemplate[key].type, value: '' };
            }
        }
        row[AP_SUB_PO_NUM] = { type: 'SINGLE_LINE_TEXT', value: poNum, lookup: true };
        return { value: row };
    }

    // ══════════════════════════════════════════════════════════════════
    //  查詢廠商所有未結案進貨單並大批帶入
    // ══════════════════════════════════════════════════════════════════

    async function fillSubTableFromVendor(vendorName) {
        try {
            const query = `${PO_VENDOR_FIELD} = "${vendorName}" and ${PO_STATUS_FIELD} not in ("已立帳核銷")`;
            const resp = await kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
                app: PO_APP_ID, query,
            });

            const obj = kintone.app.record.get();
            if (!obj) return;

            if (resp.records.length === 0) {
                showToast(`🎉 【${vendorName}】目前沒有任何未結帳的單據`, 'success');
                obj.record[AP_SUBTABLE].value = [];
            } else {
                showToast(`🔍 找到 ${resp.records.length} 筆未結帳單據，已自動帶入！`, 'success');
                obj.record[AP_SUBTABLE].value = resp.records.map(r => createSubRow(r[PO_NUM_FIELD].value));
            }

            // 🔒 每次用 kintone.app.record.set() 覆寫畫面，都要重新補上鎖定
            reapplyLock(obj.record);
            kintone.app.record.set(obj);
        } catch (err) {
            console.error('[AP] 查詢未結採購單失敗:', err);
            showToast('查詢單據時發生錯誤', 'error');
        }
    }

    function resolveCompletedDate(record) {
        const getVal = (field) => {
            if (!record[field] || !record[field].value) return '';
            return Array.isArray(record[field].value) ? record[field].value.join(',') : String(record[field].value).trim();
        };

        const payMethod = getVal(AP_PAY_METHOD);
        let date = '';

        if (payMethod.includes('支票')) {
            date = getVal(AP_CHEQUE_DATE);
        } else if (payMethod) {
            date = getVal(AP_PAY_DATE);
        }

        if (!date) date = getVal(AP_CREATE_DATE);
        if (!date) {
            const sysCreated = getVal('建立時間');
            date = sysCreated ? sysCreated.split('T')[0] : new Date().toISOString().split('T')[0];
        }
        return date;
    }

    function collectPoNumbers(record) {
        const nums = new Set();
        (record[AP_SUBTABLE]?.value || []).forEach(row => {
            const n = row.value[AP_SUB_PO_NUM]?.value;
            if (n) nums.add(n);
        });
        const header = record[AP_HEADER_PO_NUM]?.value;
        if (header) nums.add(header);
        return [...nums];
    }

    // ══════════════════════════════════════════════════════════════════
    //  事件：進入畫面
    // ══════════════════════════════════════════════════════════════════

    kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {
        const record = event.record;
        pageLoadPayStatus = record[AP_PAY_STATUS]?.value || '';
        captureRowTemplate(record);

        if (event.type === 'app.record.create.show') {
            // 🌟 複製防呆：
            // kintone「複製」一張既有紀錄時，會把來源紀錄的所有欄位值
            // （包含已產生過的 應付帳款單號、拋轉來源的 採購進貨單號）
            // 整包帶進這個 create.show 事件。
            // 真正從採購單「拋轉」過來的全新單，應付帳款單號一定還是空的
            // （尚未產生），所以用「應付帳款單號是否已有值」來判斷這是
            // 複製操作，而不是真的拋轉。
            const isCopy = !!(record[LOCKED_AP_NUM_FIELD] && record[LOCKED_AP_NUM_FIELD].value);

            if (isCopy) {
                // 清空動作併入下方的 setTimeout(0)，用明確 get()/set() 寫回，
                // 不能只改這裡的 event.record 再 return（實測不可靠、不會反映到畫面）。
                setTimeout(() => {
                    const obj = kintone.app.record.get();
                    if (!obj) return;
                    if (obj.record[LOCKED_AP_NUM_FIELD]) obj.record[LOCKED_AP_NUM_FIELD].value = '';
                    if (obj.record[AP_HEADER_PO_NUM]) obj.record[AP_HEADER_PO_NUM].value = '';
                    reapplyLock(obj.record);
                    kintone.app.record.set(obj);
                }, 0);
            } else {
                const headerPoNum = record[AP_HEADER_PO_NUM]?.value;
                if (headerPoNum) {
                    setTimeout(() => {
                        const obj = kintone.app.record.get();
                        if (!obj) return;
                        obj.record[AP_SUBTABLE].value = [createSubRow(headerPoNum)];
                        reapplyLock(obj.record);   // 🔒
                        kintone.app.record.set(obj);
                        showToast(`已帶入指定進貨單：${headerPoNum}`, 'success');
                    }, 200);
                }
            }
        }

        loadVendorDiscount(record[AP_VENDOR_CODE]?.value);
        updateDiscountHint(record);

        // 🔒 畫面渲染完成後，明確呼叫一次 get()/set() 強制鎖定（編輯畫面走這條，
        // 新增且非複製、非拋轉的空白畫面也走這條）。
        // 複製情境的鎖定已併入上面 isCopy 分支的 setTimeout(0) 一起處理，
        // 這裡不再重複，避免兩個 setTimeout(0) 互搶 get()/set() 造成其中一個被蓋掉。
        if (!(event.type === 'app.record.create.show' && record[LOCKED_AP_NUM_FIELD] && record[LOCKED_AP_NUM_FIELD].value)) {
            setTimeout(() => {
                const obj = kintone.app.record.get();
                if (!obj) return;
                reapplyLock(obj.record);
                kintone.app.record.set(obj);
            }, 0);
        }

        return event;
    });

    // ══════════════════════════════════════════════════════════════════
    //  事件：廠商代號變更（手動輸入或查閱時）
    // ══════════════════════════════════════════════════════════════════

    kintone.events.on([
        'app.record.create.change.' + AP_VENDOR_FIELD,
        'app.record.edit.change.' + AP_VENDOR_FIELD,
    ], function (event) {
        const record = event.record;
        const vendorCode = record[AP_VENDOR_CODE].value;
        const vendorName = record[AP_VENDOR_FIELD].value;
        const headerPoNum = record[AP_HEADER_PO_NUM]?.value;

        loadVendorDiscount(vendorCode);

        // 🌟 若使用者「清除廠商資料」，立刻同步清空折讓提示與子表格明細！
        if (!vendorCode) {
            record[AP_DISCOUNT_IN].error = null;
            if (!headerPoNum) {
                record[AP_SUBTABLE].value = [];
            }
            reapplyLock(record);   // 🔒
            return event; // 同步返回 event，畫面瞬間清空
        }

        updateDiscountHint(record);
        reapplyLock(record);   // 🔒

        // 若有表頭進貨單號代表是跳轉來的單，不再重新刷所有單據
        if (headerPoNum) {
            return event;
        }

        // 發動非同步查詢未結案單據（內部已於 kintone.app.record.set 前補鎖）
        fillSubTableFromVendor(vendorName);

        return event;
    });

    // ══════════════════════════════════════════════════════════════════
    //  事件：本次折讓金額變更 → 更新提示
    // ══════════════════════════════════════════════════════════════════

    kintone.events.on([
        'app.record.create.change.' + AP_DISCOUNT_IN,
        'app.record.edit.change.' + AP_DISCOUNT_IN,
    ], function (event) {
        updateDiscountHint(event.record);
        reapplyLock(event.record);   // 🔒
        return event;
    });

    // ══════════════════════════════════════════════════════════════════
    //  事件：儲存前驗證 → 折讓金額不得超過餘額
    // ══════════════════════════════════════════════════════════════════

    kintone.events.on(['app.record.create.submit', 'app.record.edit.submit'], function (event) {
        const record = event.record;
        const inputVal = parseFloat(record[AP_DISCOUNT_IN].value) || 0;

        reapplyLock(record);   // 🔒 儲存瞬間也確保鎖定狀態不被繞過

        if (inputVal <= 0) return event;

        if (!currentVendorRecordId) {
            loadVendorDiscount(record[AP_VENDOR_CODE]?.value);
        }
        if (!currentVendorRecordId) {
            record[AP_DISCOUNT_IN].error = '❌ 請先選擇廠商';
            return event;
        }
        if (inputVal > currentBalance) {
            record[AP_DISCOUNT_IN].error =
                `❌ 無法儲存：折讓金額（${inputVal.toLocaleString()} 元）` +
                `超過可用餘額（${currentBalance.toLocaleString()} 元）`;
            return event;
        }
        record[AP_DISCOUNT_IN].error = null;
        return event;
    });

    // ══════════════════════════════════════════════════════════════════
    //  事件：儲存成功後 → 執行後台回寫任務
    // ══════════════════════════════════════════════════════════════════

    kintone.events.on([
        'app.record.create.submit.success',
        'app.record.edit.submit.success',
    ], async function (event) {
        const record = event.record;
        const isNew = event.type === 'app.record.create.submit.success';
        const payStatus = record[AP_PAY_STATUS]?.value || '';

        if (payStatus !== '已付訖') return event;
        if (!isNew && pageLoadPayStatus === '已付訖') return event;

        const inputVal = parseFloat(record[AP_DISCOUNT_IN]?.value) || 0;
        const completedDate = resolveCompletedDate(record);
        const poNums = collectPoNumbers(record);
        const promises = [];

        if (inputVal > 0) {
            if (!currentVendorRecordId) loadVendorDiscount(record[AP_VENDOR_CODE]?.value);
            if (currentVendorRecordId) {
                const newBalance = Math.max(currentBalance - inputVal, 0);
                promises.push(
                    kintone.api(kintone.api.url('/k/v1/record', true), 'PUT', {
                        app: VENDOR_APP_ID, id: currentVendorRecordId,
                        record: { '折讓餘額': { value: newBalance } },
                    })
                );
            }
        }

        if (poNums.length > 0) {
            promises.push(
                kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
                    app: PO_APP_ID, query: `${PO_NUM_FIELD} in ("${poNums.join('","')}")`,
                }).then(resp => {
                    if (!resp.records.length) return;
                    const updates = resp.records.map(r => ({
                        id: r.$id.value,
                        record: {
                            [PO_STATUS_FIELD]: { value: ['已立帳核銷'] },
                            [PO_PAY_DATE_FIELD]: { value: completedDate },
                        },
                    }));
                    return kintone.api(kintone.api.url('/k/v1/records', true), 'PUT', {
                        app: PO_APP_ID, records: updates,
                    });
                })
            );
        }

        if (!promises.length) return event;

        try {
            await Promise.all(promises);
        } catch (err) {
            console.error('[AP] 後台資料同步失敗:', err);
            showToast('部分後台資料同步失敗，請確認採購單狀態', 'warn');
        }

        return event;
    });

})();