require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// Supabase 設定
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Middleware
app.use(cors()); // 允許跨域
app.use(bodyParser.json({ limit: '50mb' })); // 支援大圖片 Base64 上傳 (若保留舊邏輯)
app.use(bodyParser.urlencoded({ extended: true }));

// ================= API 路由對應 GAS 功能 =================

// 1. 取得系統狀態 (註冊開關)
app.get('/api/getSystemStatus', async (req, res) => {
    const { data, error } = await supabase.from('app_config').select('value').eq('key', 'RegistrationStatus').single();
    if (error) return res.json({ status: 'error', msg: error.message });
    res.json({ status: 'success', registration: data?.value || 'OPEN' });
});

// 2. 取得條款
app.get('/api/getTerms', async (req, res) => {
    const { data } = await supabase.from('app_config').select('value').eq('key', 'MerchantTerms').single();
    res.json({ status: 'success', terms: data?.value || '' });
});

// 3. 取得所有商品 (包含篩選邏輯)
app.get('/api/products', async (req, res) => {
    const { shopId } = req.query;
    if (!shopId) return res.json({ status: 'success', shopName: '拍拍購 InsBuy', data: [] });

    // 先抓商店資訊
    const { data: shop } = await supabase.from('shops').select('*').eq('shop_id', shopId).single();
    if (!shop) return res.json({ status: 'error', msg: '找不到商店' });

    // 抓商品
    const { data: products } = await supabase.from('products').select('*').eq('shop_id', shopId);
    
    // 轉換格式以符合前端 Vue 的預期 (大小寫轉換 mapping)
    const formattedProducts = products.map(p => ({
        ProductID: p.product_id,
        ProductName: p.name,
        Description: p.description,
        Images: p.images, // 這裡假設存的是字串
        Price: p.price,
        OriginalPrice: p.original_price,
        TotalStock: p.total_stock,
        TargetAmount: p.target_amount,
        CurrentAmount: p.current_amount,
        EndTime: p.end_time,
        Status: p.status,
        IsDeleted: p.is_deleted ? 'TRUE' : 'FALSE',
        ShippingMethod: JSON.stringify(p.shipping_config), // 前端預期是 JSON String
        ShippingFee: p.shipping_fee,
        BankInfo: JSON.stringify(p.bank_info),
        Variants: p.variants, // JSONB 直接回傳
        FaceToFaceAddress: p.face_to_face_address,
        VipConfig: JSON.stringify(p.vip_config),
        Questions: p.questions
    }));

    // 取得等級規則 (這邊簡化為固定回傳，或可從資料庫讀取)
    const levelRules = { "1": { imgLimit: 5, maxActive: 10, maxDays: 7, canDelete: false, canEdit: false }, "99": { imgLimit: 99, maxActive: 999, maxDays: 365, canDelete: true, canEdit: true } };

    res.json({
        status: 'success',
        shopName: shop.name,
        sheetId: 'DB_MANAGED_BY_SUPABASE', // 不再需要 Google Sheet ID
        levelRules: levelRules,
        shopLevel: shop.level,
        data: formattedProducts,
        logo: shop.logo_url
    });
});

// 4. 登入
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const { data, error } = await supabase.from('shops').select('*').eq('email', email).eq('password', password).single();
    
    if (error || !data) return res.json({ status: 'error', msg: '帳號或密碼錯誤' });
    if (data.status === 'Banned') return res.json({ status: 'error', msg: '帳號已被停權' });

    res.json({ status: 'success', shopId: data.shop_id, level: data.level });
});

// 5. 註冊
app.post('/api/register', async (req, res) => {
    const { shopName, email, password, phone, company, taxId } = req.body;
    
    // 檢查 Email
    const { data: existing } = await supabase.from('shops').select('shop_id').eq('email', email);
    if (existing && existing.length > 0) return res.json({ status: 'error', msg: 'Email 已註冊' });

    // 產生 ShopID (簡易版: S + timestamp)
    const shopId = 'S' + Date.now().toString().slice(-4); 

    const { error } = await supabase.from('shops').insert([{
        shop_id: shopId,
        name: shopName,
        email,
        password,
        level: 1,
        status: 'Active'
    }]);

    if (error) return res.json({ status: 'error', msg: error.message });
    res.json({ status: 'success', shopId });
});

// 6. 建立/更新商品
app.post('/api/createProduct', async (req, res) => {
    const p = req.body;
    const pid = p.productId ? p.productId : 'P' + Date.now();
    
    // 整理資料
    const productData = {
        product_id: pid,
        shop_id: p.shopId, // 確保前端有傳 shopId
        name: p.name,
        description: p.description,
        images: p.images,
        price: p.price,
        original_price: p.originalPrice,
        total_stock: p.totalStock || 0,
        target_amount: p.targetAmount,
        end_time: new Date(Date.now() + parseInt(p.duration) * 86400000).toISOString(),
        status: 'OPEN',
        is_deleted: false,
        shipping_config: p.shipping, // JSON array
        shipping_fee: p.shippingFee,
        bank_info: p.bank, // JSON object
        variants: p.variants, // JSON array
        face_to_face_address: p.faceToFaceAddress,
        vip_config: p.vipConfig,
        questions: p.questions
    };

    // 計算總庫存
    if (p.variants && p.variants.length > 0) {
        productData.total_stock = p.variants.reduce((sum, v) => sum + parseInt(v.stock), 0);
    }

    const { error } = await supabase.from('products').upsert(productData); // Upsert: 有ID則更新，無則新增
    
    if (error) return res.json({ status: 'error', msg: error.message });
    res.json({ status: 'success', msg: '商品已發布' });
});

// 7. 下單 (包含交易邏輯)
app.post('/api/submitOrder', async (req, res) => {
    const { shopId, cart, customer } = req.body;
    
    // 生成訂單編號
    const dateStr = new Date().toISOString().slice(0,10).replace(/-/g, "");
    const orderId = dateStr + Math.floor(Math.random() * 1000).toString().padStart(3, '0');

    // 準備訂單資料
    const orderData = {
        order_id: orderId,
        shop_id: shopId,
        customer_name: customer.name,
        customer_phone: customer.phone,
        customer_address: customer.address,
        shipping_method: customer.shipping,
        payment_last5: customer.last5,
        note: customer.note,
        meet_time: customer.meetTime ? new Date(customer.meetTime) : null,
        items: cart, // 直接存 JSON
        total_amount: cart.reduce((sum, item) => sum + item.total, 0),
        status: '已下單'
    };

    // --- 交易與庫存扣除邏輯 ---
    // 注意：為了簡化遷移，這裡使用 JS 邏輯處理庫存檢查，嚴格來說應該用 SQL Function 處理併發
    
    // A. 檢查庫存
    for (const item of cart) {
        const { data: product } = await supabase.from('products').select('*').eq('product_id', item.productId).single();
        if (!product) return res.json({ status: 'error', msg: `商品 ${item.productName} 不存在` });

        // 檢查是否有規格
        if (item.variantName) {
            const variant = product.variants.find(v => v.name === item.variantName);
            if (!variant || parseInt(variant.stock) < item.qty) {
                return res.json({ status: 'error', msg: `商品 ${item.productName} - ${item.variantName} 庫存不足` });
            }
        } else {
             if (product.total_stock < item.qty) {
                return res.json({ status: 'error', msg: `商品 ${item.productName} 庫存不足` });
             }
        }
    }

    // B. 扣庫存並建立訂單
    // 逐一更新每個商品的庫存
    for (const item of cart) {
        const { data: product } = await supabase.from('products').select('*').eq('product_id', item.productId).single();
        
        let newVariants = product.variants;
        let newTotalStock = product.total_stock;
        let newCurrentAmount = (product.current_amount || 0) + item.total;

        if (item.variantName) {
             newVariants = product.variants.map(v => {
                 if (v.name === item.variantName) {
                     v.stock = parseInt(v.stock) - item.qty;
                 }
                 return v;
             });
             newTotalStock = newVariants.reduce((sum, v) => sum + parseInt(v.stock), 0);
        } else {
             newTotalStock = product.total_stock - item.qty;
        }

        await supabase.from('products').update({
            variants: newVariants,
            total_stock: newTotalStock,
            current_amount: newCurrentAmount
        }).eq('product_id', item.productId);
    }

    // C. 寫入訂單
    const { error: orderError } = await supabase.from('orders').insert([orderData]);
    if (orderError) return res.json({ status: 'error', msg: orderError.message });

    res.json({ status: 'success', orderId: orderId });
});

// 8. 訂單查詢
app.get('/api/inquiry', async (req, res) => {
    const { phone, shopId } = req.query;
    const { data: orders } = await supabase.from('orders').select('*').eq('shop_id', shopId).eq('customer_phone', phone);
    
    // 轉換格式以符合前端
    const formattedOrders = orders.map(o => ({
        orderId: o.order_id,
        date: new Date(o.created_at).toLocaleDateString(),
        status: o.status,
        total: o.total_amount,
        items: o.items.map(i => ({
            name: i.productName,
            variant: i.variantName,
            qty: i.qty,
            price: i.price
        }))
    }));

    res.json({ status: 'success', orders: formattedOrders });
});

// 9. 更新商店資訊
app.post('/api/updateShopInfo', async (req, res) => {
    const { shopId, shopName, shopLogo } = req.body;
    const { error } = await supabase.from('shops').update({ name: shopName, logo_url: shopLogo }).eq('shop_id', shopId);
    if (error) return res.json({ status: 'error', msg: error.message });
    res.json({ status: 'success', msg: '更新成功' });
});

// 10. 銷售統計
app.get('/api/getStats', async (req, res) => {
    const { shopId } = req.query;
    // 這裡做簡易統計，實際可用 Supabase aggregation
    const { data: orders } = await supabase.from('orders').select('total_amount, created_at').eq('shop_id', shopId);
    
    let daily = 0;
    let monthly = 0;
    const now = new Date();
    
    orders.forEach(o => {
        const d = new Date(o.created_at);
        if (d.getDate() === now.getDate() && d.getMonth() === now.getMonth()) daily += o.total_amount;
        if (d.getMonth() === now.getMonth()) monthly += o.total_amount;
    });

    res.json({ status: 'success', daily, monthly });
});

// 11. 刪除商品
app.post('/api/deleteProduct', async (req, res) => {
    const { pid } = req.body;
    await supabase.from('products').update({ is_deleted: true }).eq('product_id', pid);
    res.json({ status: 'success', msg: '已刪除' });
});

// 路由轉發 (處理原本 GAS 的單一入口結構)
app.all('/api', (req, res) => {
    // 為了相容，可以在此做轉發，但建議前端直接打對應的 endpoint
    // 這裡簡單回傳，引導前端直接改用上述定義的 routes
    res.status(404).send('Please use specific endpoints like /api/login');
});

// 啟動 Server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});