const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 連線 Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ---------------- API 區域 ----------------

// 1. 【新功能】動態分享卡片 (讓 LINE 顯示漂亮預覽圖)
app.get('/api/share/product/:productId', async (req, res) => {
    const { productId } = req.params;
    const { data: product } = await supabase.from('products').select('*').eq('product_id', productId).single();

    if (!product) return res.send('商品不存在');

    const remaining = product.total_stock - (product.current_amount || 0);
    const img = product.images ? product.images.split('\n')[0] : 'https://placehold.co/600x400';
    // 導向回您的 Vercel 前端
    const frontendUrl = `https://insbuy-project.vercel.app?shopId=${product.shop_id}&productId=${productId}`;

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta property="og:title" content="🔥 剩 ${remaining} 組！${product.name}" />
        <meta property="og:description" content="原價 $${product.original_price}，特價 $${product.price}！" />
        <meta property="og:image" content="${img}" />
        <meta property="og:type" content="product" />
        <script>window.location.href = "${frontendUrl}";</script>
    </head>
    <body>跳轉中...</body>
    </html>
    `;
    res.send(html);
});

// 2. 【新功能】AI 智慧訂單解析
app.post('/api/ai-parse', (req, res) => {
    const { text } = req.body;
    // 抓取 "文字+數字" 格式 (例如: 紅色+1)
    const regex = /([\u4e00-\u9fa5a-zA-Z0-9]+)[\s\+\*]*(\d+)/g;
    let match;
    const results = [];
    while ((match = regex.exec(text)) !== null) {
        if (isNaN(match[1])) { // 排除純數字
            results.push({ variant: match[1], qty: parseInt(match[2]) });
        }
    }
    res.json({ status: 'success', data: results });
});

// 3. 【補回功能】建立訂單 (包含扣庫存邏輯)
app.post('/api/orders', async (req, res) => {
    const { shopId, items, customer, total, couponId, discount } = req.body;

    // A. 產生訂單編號 (格式: YYYYMMDD-亂碼)
    const orderId = new Date().toISOString().slice(0,10).replace(/-/g,'') + '-' + Math.floor(1000 + Math.random() * 9000);

    // B. 寫入訂單主表
    const { error: orderError } = await supabase.from('orders').insert([{
        order_id: orderId,
        shop_id: shopId,
        customer_name: customer.name,
        customer_phone: customer.phone,
        customer_address: customer.address,
        shipping_method: customer.shipping,
        payment_last5: customer.last5, // 匯款後五碼
        items: items, // 購買明細直接存 JSON
        total_amount: total,
        coupon_id: couponId || null,
        discount_applied: discount || 0,
        status: '已下單',
        status_detail: 'pending_payment'
    }]);

    if (orderError) return res.status(500).json({ status: 'error', msg: orderError.message });

    // C. 扣除庫存 (這裡做簡單版：更新已售出數量)
    // 正式版建議用 Transaction，但在 Supabase 簡單做可以用 RPC 或迴圈更新
    for (const item of items) {
        // 找出商品目前的已售數量
        const { data: prod } = await supabase.from('products').select('current_amount').eq('product_id', item.productId).single();
        if (prod) {
            const newAmount = (prod.current_amount || 0) + item.qty;
            await supabase.from('products').update({ current_amount: newAmount }).eq('product_id', item.productId);
        }
    }

    res.json({ status: 'success', orderId });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));