const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {Pool}=require('pg');

const envFile=path.join(__dirname,'.env');
if(fs.existsSync(envFile)){
  for(const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/)){
    const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^\"|\"$/g,'');
  }
}
const PORT=Number(process.env.PORT||3000);
const ROOT=__dirname;
const ADMIN_EMAIL=process.env.ADMIN_EMAIL||'admin@example.com';
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'CHANGE_THIS_BEFORE_DEPLOY';
const SESSION_SECRET=process.env.SESSION_SECRET||'CHANGE_THIS_TO_A_LONG_RANDOM_SECRET';
const DATABASE_URL=process.env.DATABASE_URL||'';
const CASHFREE_APP_ID=process.env.CASHFREE_APP_ID||'';
const CASHFREE_SECRET_KEY=process.env.CASHFREE_SECRET_KEY||'';
const CASHFREE_ENV=(process.env.CASHFREE_ENV||'sandbox').toLowerCase();
const CASHFREE_API_VERSION=process.env.CASHFREE_API_VERSION||'2025-01-01';
const PUBLIC_BASE_URL=(process.env.PUBLIC_BASE_URL||'').replace(/\/$/,'');
const CASHFREE_BASE_URL=CASHFREE_ENV==='production'?'https://api.cashfree.com/pg':'https://sandbox.cashfree.com/pg';

if(!DATABASE_URL)console.warn('DATABASE_URL is not configured');

const pool=new Pool({
  connectionString:DATABASE_URL||undefined,
  ssl:DATABASE_URL?{rejectUnauthorized:false}:false,
  max:5,
  idleTimeoutMillis:30000,
  connectionTimeoutMillis:10000
});
pool.on('error',e=>console.error('Postgres pool error:',e.message));

async function initDb(){
  if(!DATABASE_URL)throw Error('DATABASE_URL is not configured');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pack TEXT NOT NULL,
      price INTEGER NOT NULL,
      stock INTEGER NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS orders(
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      customer JSONB NOT NULL,
      items JSONB NOT NULL,
      subtotal INTEGER NOT NULL,
      shipping INTEGER NOT NULL,
      total INTEGER NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'received',
      cashfree_order_id TEXT,
      cashfree_environment TEXT,
      payment_session_id TEXT,
      inventory_deducted BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customers(
      phone TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      password_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT;
    CREATE TABLE IF NOT EXISTS customer_sessions(
      token TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS inventory_deducted BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_access_token TEXT UNIQUE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_orders_access_token ON orders (order_access_token);
    UPDATE orders SET order_access_token=encode(gen_random_bytes(32),'hex') WHERE order_access_token IS NULL;
    CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders ((customer->>'phone'));
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_customer_sessions_phone ON customer_sessions (phone);
    CREATE INDEX IF NOT EXISTS idx_customer_sessions_expires_at ON customer_sessions (expires_at);
  `);
  const {rows}=await pool.query('SELECT COUNT(*)::int AS count FROM products');
  if(rows[0].count===0){
    await pool.query(
      'INSERT INTO products(id,name,pack,price,stock,active) VALUES ($1,$2,$3,$4,$5,$6),($7,$8,$9,$10,$11,$12),($13,$14,$15,$16,$17,$18)',
      [
        'ghee-500','A2 Bilona Desi Cow Ghee','500 ml',999,null,true,
        'ghee-1000','A2 Bilona Desi Cow Ghee','1 kg',1999,null,true,
        'ghee-2500','A2 Bilona Desi Cow Ghee','2.5 kg',4999,null,true
      ]
    );
  }
}
async function markOrderPaid(id){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const r=await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id]);
    if(!r.rowCount){await client.query('ROLLBACK');return false;}
    const o=r.rows[0];
    if(!o.inventory_deducted){
      for(const item of (o.items||[])){
        const q=Number(item.quantity)||0;
        if(q>0){
          const u=await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2 AND stock IS NOT NULL AND stock >= $1',[q,item.productId]);
          if(u.rowCount===0){
            const p=await client.query('SELECT stock,pack FROM products WHERE id=$1',[item.productId]);
            if(p.rowCount && p.rows[0].stock!==null)throw Error('Insufficient stock for '+p.rows[0].pack);
          }
        }
      }
      await client.query("UPDATE orders SET inventory_deducted=TRUE,payment_status='paid',status='payment_confirmed' WHERE id=$1",[id]);
    }else{
      await client.query("UPDATE orders SET payment_status='paid',status='payment_confirmed' WHERE id=$1",[id]);
    }
    await client.query('COMMIT');return true;
  }catch(e){await client.query('ROLLBACK');throw e}
  finally{client.release()}
}
async function dbProducts(activeOnly=false){
  const r=await pool.query(activeOnly?'SELECT id,name,pack,price,stock,active FROM products WHERE active=true ORDER BY price':'SELECT id,name,pack,price,stock,active FROM products ORDER BY price');
  return r.rows;
}
async function dbOrder(id){
  const r=await pool.query('SELECT * FROM orders WHERE id=$1',[id]);
  return r.rows[0]||null;
}
function rowOrder(r){
  if(!r)return null;
  return {id:r.id,createdAt:new Date(r.created_at).toISOString(),customer:r.customer,items:r.items,subtotal:r.subtotal,shipping:r.shipping,total:r.total,paymentStatus:r.payment_status,status:r.status,cashfreeOrderId:r.cashfree_order_id||null,cashfreeEnvironment:r.cashfree_environment||null,paymentSessionId:r.payment_session_id||null,courier:r.courier||null,trackingNumber:r.tracking_number||null,dispatchedAt:r.dispatched_at?new Date(r.dispatched_at).toISOString():null};
}
async function saveOrder(o){
  await pool.query(
    `INSERT INTO orders(id,created_at,customer,items,subtotal,shipping,total,payment_status,status,cashfree_order_id,cashfree_environment,payment_session_id,order_access_token)
     VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT(id) DO UPDATE SET customer=EXCLUDED.customer,items=EXCLUDED.items,subtotal=EXCLUDED.subtotal,shipping=EXCLUDED.shipping,total=EXCLUDED.total,payment_status=EXCLUDED.payment_status,status=EXCLUDED.status,cashfree_order_id=EXCLUDED.cashfree_order_id,cashfree_environment=EXCLUDED.cashfree_environment,payment_session_id=EXCLUDED.payment_session_id`,
    [o.id,o.createdAt,JSON.stringify(o.customer),JSON.stringify(o.items),o.subtotal,o.shipping,o.total,o.paymentStatus,o.status,o.cashfreeOrderId||null,o.cashfreeEnvironment||null,o.paymentSessionId||null,o.orderAccessToken||token()]
  );
}
function json(res,status,obj){const s=JSON.stringify(obj);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(s)}
function body(req){return new Promise((resolve,reject)=>{let d='';req.on('data',c=>{d+=c;if(d.length>1e6)req.destroy()});req.on('end',()=>{try{resolve(d?JSON.parse(d):{})}catch(e){reject(e)}});req.on('error',reject)})}
function token(){return crypto.randomBytes(32).toString('hex')}
async function auth(req){
  const h=req.headers.authorization||'';
  if(!h.startsWith('Bearer '))return false;
  const r=await pool.query('SELECT token FROM sessions WHERE token=$1 AND expires_at>NOW()',[h.slice(7)]);
  return r.rowCount>0;
}
function orderId(){const d=new Date().toISOString().slice(0,10).replaceAll('-','');return `RF-${d}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`}
function requireCashfree(){if(!CASHFREE_APP_ID||!CASHFREE_SECRET_KEY)throw Error('Cashfree credentials are not configured on the server')}
async function cashfreeFetch(endpoint,options={}){
  requireCashfree();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  let r;
  try{
    r=await fetch(CASHFREE_BASE_URL+endpoint,{...options,signal:controller.signal,headers:{'x-client-id':CASHFREE_APP_ID,'x-client-secret':CASHFREE_SECRET_KEY,'x-api-version':CASHFREE_API_VERSION,'Accept':'application/json','Content-Type':'application/json',...(options.headers||{})}});
  }catch(e){if(e.name==='AbortError')throw Error('Cashfree request timed out');throw e}finally{clearTimeout(timer)}

  const raw=await r.text();let data;try{data=raw?JSON.parse(raw):{}}catch{data={raw}}
  if(!r.ok){const e=new Error(data?.message||data?.error_description||`Cashfree API error (${r.status})`);e.status=r.status;e.details=data;throw e}
  return data;
}
function verifyWebhook(rawBody,signature,timestamp){
  if(!CASHFREE_SECRET_KEY||!signature||!timestamp)return false;
  const expected=crypto.createHmac('sha256',CASHFREE_SECRET_KEY).update(String(timestamp)+rawBody).digest('base64');
  const a=Buffer.from(expected),b=Buffer.from(String(signature));
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
async function calc(items){
  const requested=[...new Set((items||[]).map(i=>String(i.productId||'')).filter(Boolean))];
  if(!requested.length)throw Error('Cart is empty');
  const r=await pool.query('SELECT id,name,pack,price,stock,active FROM products WHERE active=true AND id=ANY($1::text[])',[requested]);
  const products=r.rows;
  let subtotal=0;const normalized=[];
  for(const i of (items||[])){
    const p=products.find(x=>x.id===i.productId);
    const q=Math.max(1,Math.min(99,Number(i.quantity)||1));
    if(!p)throw Error('Invalid product');
    if(Number.isInteger(p.stock)&&q>p.stock)throw Error(`Insufficient stock for ${p.pack}`);
    const unitPrice=p.price;
    subtotal+=unitPrice*q;
    normalized.push({productId:p.id,name:p.name,pack:p.pack,unitPrice,quantity:q});
  }
  if(!normalized.length)throw Error('Cart is empty');
  const shipping=subtotal>=1999?0:101;
  return {items:normalized,subtotal,shipping,total:subtotal+shipping};
}
const cashfreeStatusCache=new Map();
function cachedCashfreeStatus(id,value){const now=Date.now(),hit=cashfreeStatusCache.get(id);if(hit&&now-hit.at<5000)return hit.value;cashfreeStatusCache.set(id,{at:now,value});if(cashfreeStatusCache.size>2000){for(const [k,v] of cashfreeStatusCache)if(now-v.at>15000)cashfreeStatusCache.delete(k)}return value}
const orderStatusCache=new Map();
function cachedOrderStatus(id,row){
  const now=Date.now(),hit=orderStatusCache.get(id);
  if(hit&&now-hit.at<5000)return hit.value;
  orderStatusCache.set(id,{at:now,value:row});
  if(orderStatusCache.size>2000){for(const [k,v] of orderStatusCache)if(now-v.at>15000)orderStatusCache.delete(k)}
  return row;
}
function normalizePhone(v){let p=String(v||'').replace(/\D/g,'');if(p.startsWith('91')&&p.length===12)p=p.slice(2);return p.length===10?p:null}
function allowPaymentCreate(key){
  const now=Date.now(),x=paymentAttempts.get(key)||{count:0,at:now};
  if(now-x.at>60*1000){x.count=0;x.at=now}
  x.count++;
  paymentAttempts.set(key,x);
  if(paymentAttempts.size>5000){for(const [k,v] of paymentAttempts)if(now-v.at>60*1000)paymentAttempts.delete(k)}
  return x.count<=10;
}
const loginAttempts=new Map();
function allowCustomerLogin(key){
  const now=Date.now(),x=loginAttempts.get(key)||{count:0,at:now};
  if(now-x.at>15*60*1000){x.count=0;x.at=now}
  x.count++;
  loginAttempts.set(key,x);
  if(loginAttempts.size>5000){for(const [k,v] of loginAttempts)if(now-v.at>15*60*1000)loginAttempts.delete(k)}
  return x.count<=8;
}
async function customerAuth(req){const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return null;const r=await pool.query('SELECT phone FROM customer_sessions WHERE token=$1 AND expires_at>NOW()',[h.slice(7)]);return r.rowCount?r.rows[0].phone:null}
async function api(req,res){
  const u=new URL(req.url,`http://${req.headers.host}`),p=u.pathname;
  try{
    if(req.method==='GET'&&p==='/api/health'){
      try{
        await pool.query('SELECT 1');
        return json(res,200,{ok:true,service:'rudraksha-farm',database:true,time:new Date().toISOString()});
      }catch(e){
        console.error('Health check database error:',e.message);
        return json(res,503,{ok:false,service:'rudraksha-farm',database:false,time:new Date().toISOString()});
      }
    }
    if(req.method==='GET'&&p==='/api/products')return json(res,200,{products:(await dbProducts(true)).map(({id,name,pack,price,stock})=>({id,name,pack,price,available:Number.isInteger(stock)?stock>0:false}))});
    if(req.method==='POST'&&p==='/api/customer/register'){
      const b=await body(req),phone=normalizePhone(b.phone),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');
      if(!phone||password.length<8)return json(res,400,{error:'Valid mobile number and password of at least 8 characters are required'});
      if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json(res,400,{error:'Enter a valid email address'});
      const existing=await pool.query('SELECT phone FROM customers WHERE phone=$1',[phone]);
      if(existing.rowCount)return json(res,409,{error:'An account already exists for this mobile number. Please login.'});
      const hash=await new Promise((resolve,reject)=>crypto.scrypt(password,SESSION_SECRET,64,(e,k)=>e?reject(e):resolve(k.toString('hex'))));
      await pool.query('INSERT INTO customers(phone,name,email,password_hash,created_at,last_login_at) VALUES($1,$2,$3,$4,NOW(),NOW())',[phone,String(b.name||'').trim()||null,email||null,hash]);
      const t=token();await pool.query('INSERT INTO customer_sessions(token,phone,expires_at) VALUES($1,$2,NOW()+INTERVAL \'30 days\')',[t,phone]);
      return json(res,201,{token:t,phone:'+91'+phone});
    }
    if(req.method==='POST'&&p==='/api/customer/login'){
      const b=await body(req),phone=normalizePhone(b.phone),password=String(b.password||'');
      if(!phone||!password)return json(res,400,{error:'Mobile number and password are required'});
      const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();
      if(!allowCustomerLogin(ip+'|'+phone))return json(res,429,{error:'Too many login attempts. Please try again later.'});
      const r=await pool.query('SELECT phone,name,password_hash FROM customers WHERE phone=$1',[phone]);
      if(!r.rowCount||!r.rows[0].password_hash)return json(res,401,{error:'Invalid mobile number or password'});
      const hash=await new Promise((resolve,reject)=>crypto.scrypt(password,SESSION_SECRET,64,(e,k)=>e?reject(e):resolve(k.toString('hex'))));
      const a=Buffer.from(hash,'hex'),bhash=Buffer.from(r.rows[0].password_hash,'hex');
      if(a.length!==bhash.length||!crypto.timingSafeEqual(a,bhash))return json(res,401,{error:'Invalid mobile number or password'});
      await pool.query('UPDATE customers SET last_login_at=NOW() WHERE phone=$1',[phone]);
      const t=token();await pool.query('INSERT INTO customer_sessions(token,phone,expires_at) VALUES($1,$2,NOW()+INTERVAL \'30 days\')',[t,phone]);
      return json(res,200,{token:t,phone:'+91'+phone});
    }
    if(req.method==='POST'&&p==='/api/customer/register-or-login'){
      return json(res,410,{error:'OTP login has been removed. Use password login.'});
    }
    if(req.method==='GET'&&p==='/api/customer/me'){
      const phone=await customerAuth(req);if(!phone)return json(res,401,{error:'Unauthorized'});
      const r=await pool.query('SELECT phone,name,email FROM customers WHERE phone=$1',[phone]);
      return json(res,200,{customer:r.rows[0]||{phone,name:null,email:null}});
    }
    if(req.method==='POST'&&p==='/api/customer/logout'){
      const h=req.headers.authorization||'';
      if(h.startsWith('Bearer '))await pool.query('DELETE FROM customer_sessions WHERE token=$1',[h.slice(7)]);
      return json(res,200,{ok:true});
    }
    if(req.method==='GET'&&p==='/api/customer/orders'){
      const phone=await customerAuth(req);if(!phone)return json(res,401,{error:'Unauthorized'});
      const r=await pool.query("SELECT id,created_at,items,total,payment_status,status,courier,tracking_number,dispatched_at FROM orders WHERE customer->>'phone' IN ($1,'+91'||$1,'91'||$1) ORDER BY created_at DESC",[phone]);
      return json(res,200,{orders:r.rows.map(o=>({id:o.id,accessToken:o.order_access_token,createdAt:new Date(o.created_at).toISOString(),items:o.items,total:o.total,paymentStatus:o.payment_status,status:o.status,courier:o.courier||null,trackingNumber:o.tracking_number||null,dispatchedAt:o.dispatched_at?new Date(o.dispatched_at).toISOString():null}))});
    }
    if(req.method==='PATCH'&&p==='/api/customer/profile'){
      const phone=await customerAuth(req);if(!phone)return json(res,401,{error:'Unauthorized'});
      const b=await body(req),name=String(b.name||'').trim(),email=String(b.email||'').trim().toLowerCase();
      if(name.length<2)return json(res,400,{error:'Name is required'});
      if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json(res,400,{error:'Enter a valid email address'});
      await pool.query('UPDATE customers SET name=$1,email=$2 WHERE phone=$3',[name,email||null,phone]);
      return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&p==='/api/customer/change-password'){
      const phone=await customerAuth(req);if(!phone)return json(res,401,{error:'Unauthorized'});
      const b=await body(req),current=String(b.currentPassword||''),next=String(b.newPassword||'');
      if(next.length<8)return json(res,400,{error:'New password must be at least 8 characters'});
      const r=await pool.query('SELECT password_hash FROM customers WHERE phone=$1',[phone]);
      if(!r.rowCount||!r.rows[0].password_hash)return json(res,400,{error:'Password account not found'});
      const oldHash=await new Promise((resolve,reject)=>crypto.scrypt(current,SESSION_SECRET,64,(e,k)=>e?reject(e):resolve(k.toString('hex'))));
      const a=Buffer.from(oldHash,'hex'),bhash=Buffer.from(r.rows[0].password_hash,'hex');
      if(a.length!==bhash.length||!crypto.timingSafeEqual(a,bhash))return json(res,401,{error:'Current password is incorrect'});
      const newHash=await new Promise((resolve,reject)=>crypto.scrypt(next,SESSION_SECRET,64,(e,k)=>e?reject(e):resolve(k.toString('hex'))));
      await pool.query('UPDATE customers SET password_hash=$1 WHERE phone=$2',[newHash,phone]);
      return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&p==='/api/admin/login'){
      if(ADMIN_EMAIL==='admin@example.com'||ADMIN_PASSWORD==='CHANGE_THIS_BEFORE_DEPLOY'||SESSION_SECRET==='CHANGE_THIS_TO_A_LONG_RANDOM_SECRET')return json(res,503,{error:'Admin credentials are not configured on the server'});
      const b=await body(req);
      if(b.email!==ADMIN_EMAIL||b.password!==ADMIN_PASSWORD)return json(res,401,{error:'Invalid credentials'});
      const t=token();
      await pool.query('DELETE FROM sessions WHERE expires_at<=NOW()');
      await pool.query('INSERT INTO sessions(token,expires_at) VALUES($1,NOW()+INTERVAL \'8 hours\')',[t]);
      return json(res,200,{token:t});
    }
    if(req.method==='POST'&&p==='/api/orders'){
      const b=await body(req);
      if(!b.customer?.name||!b.customer?.phone||!b.customer?.address)return json(res,400,{error:'Customer name, phone and address are required'});
      let c;try{c=await calc(b.items)}catch(e){return json(res,400,{error:e.message})}
      const o={id:orderId(),createdAt:new Date().toISOString(),customer:b.customer,items:c.items,subtotal:c.subtotal,shipping:c.shipping,total:c.total,paymentStatus:'pending',status:'received'};
      await saveOrder(o);return json(res,201,{order:o});
    }
    if(req.method==='POST'&&p==='/api/payments/cashfree/order'){
      const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();
      if(!allowPaymentCreate(ip))return json(res,429,{error:'Too many payment attempts. Please wait a minute and try again.'});
      const b=await body(req);
      if(!b.customer?.name||!b.customer?.phone||!b.customer?.address)return json(res,400,{error:'Customer name, phone and address are required'});
      let c;try{c=await calc(b.items)}catch(e){return json(res,400,{error:e.message})}
      const id=orderId(),accessToken=token(),customerId='rf_'+id.toLowerCase().replace(/[^a-z0-9]/g,'_');
      const payload={order_id:id,order_amount:Number(c.total.toFixed(2)),order_currency:'INR',customer_details:{customer_id:customerId,customer_name:b.customer.name,customer_phone:b.customer.phone,customer_email:b.customer.email||''},order_meta:{return_url:`${PUBLIC_BASE_URL||'http://localhost:'+PORT}/cashfree-return?order_id={order_id}&access_token=${accessToken}`}};
      if(PUBLIC_BASE_URL)payload.order_meta.notify_url=`${PUBLIC_BASE_URL}/api/payments/cashfree/webhook`;
      try{
        const cf=await cashfreeFetch('/orders',{method:'POST',body:JSON.stringify(payload)});
        const o={id,createdAt:new Date().toISOString(),customer:b.customer,items:c.items,subtotal:c.subtotal,shipping:c.shipping,total:c.total,paymentStatus:'pending',status:'received',cashfreeOrderId:cf.order_id||id,cashfreeEnvironment:CASHFREE_ENV,paymentSessionId:cf.payment_session_id||null,orderAccessToken:accessToken};
        await saveOrder(o);
        return json(res,201,{orderId:id,accessToken,paymentSessionId:cf.payment_session_id,environment:CASHFREE_ENV,total:o.total});
      }catch(e){return json(res,e.status||502,{error:e.message,details:e.details||undefined})}
    }
    if(req.method==='GET'&&p==='/cashfree-return'){
      const id=u.searchParams.get('order_id'),accessToken=u.searchParams.get('access_token');
      if(!id||!accessToken)return json(res,400,{error:'Missing order access token'});
      const o=await dbOrder(id);
      if(!o)return json(res,404,{error:'Order not found'});
      if(o.order_access_token!==accessToken)return json(res,403,{error:'Invalid order access token'});
      res.writeHead(302,{Location:`/order.html?order_id=${encodeURIComponent(id)}`,'Cache-Control':'no-store'});
      res.end();
      // Do not block the customer redirect on Cashfree's verification API.
      // Webhook remains the primary confirmation path; the order-status page
      // can trigger a verification check while the customer is viewing it.
      setImmediate(async()=>{
        try{
          const hit=cashfreeStatusCache.get(id);const payments=hit&&Date.now()-hit.at<5000?hit.value:cachedCashfreeStatus(id,await cashfreeFetch(`/orders/${encodeURIComponent(o.cashfree_order_id||id)}/payments`,{method:'GET'}));
          const success=Array.isArray(payments)&&payments.some(x=>x.payment_status==='SUCCESS');
          const pending=Array.isArray(payments)&&payments.some(x=>x.payment_status==='PENDING');
          if(success)await markOrderPaid(id);
          else if(pending)await pool.query("UPDATE orders SET payment_status='pending' WHERE id=$1",[id]);
          else await pool.query("UPDATE orders SET payment_status='failed' WHERE id=$1",[id]);
        }catch(e){console.error('Cashfree return verification failed:',e.message);}
      });
      return;
    }
    if(req.method==='GET'&&p.startsWith('/api/payments/cashfree/status/')){
      const id=p.split('/').pop(),o=await dbOrder(id);
      if(!o)return json(res,404,{error:'Order not found'});
      try{
        const payments=await cashfreeFetch(`/orders/${encodeURIComponent(o.cashfree_order_id||id)}/payments`,{method:'GET'});
        const success=Array.isArray(payments)&&payments.some(x=>x.payment_status==='SUCCESS');
        const pending=Array.isArray(payments)&&payments.some(x=>x.payment_status==='PENDING');
        const paymentStatus=success?'paid':pending?'pending':'failed';
        if(success){
          try{await markOrderPaid(id);}
          catch(e){return json(res,409,{error:e.message||'Unable to confirm payment because inventory is unavailable'});}
        }else{
          const status=o.status;
          await pool.query('UPDATE orders SET payment_status=$1,status=$2 WHERE id=$3',[paymentStatus,status,id]);
        }
        return json(res,200,{orderId:id,paymentStatus,status,payments});
      }catch(e){return json(res,e.status||502,{error:e.message})}
    }
    if(req.method==='POST'&&p==='/api/payments/cashfree/webhook'){
      const raw=await new Promise((resolve,reject)=>{let d='';req.on('data',c=>d+=c);req.on('end',()=>resolve(d));req.on('error',reject)});
      const sig=req.headers['x-webhook-signature'],ts=req.headers['x-webhook-timestamp'];
      if(!verifyWebhook(raw,sig,ts))return json(res,401,{error:'Invalid webhook signature'});
      let event;try{event=JSON.parse(raw)}catch{return json(res,400,{error:'Invalid JSON'})}
      const orderIdValue=event?.data?.order?.order_id||event?.data?.order_id||event?.order_id;
      const paymentStatus=event?.data?.payment?.payment_status||event?.data?.payment_status;
      if(orderIdValue){
        if(paymentStatus==='SUCCESS'){
          try{await markOrderPaid(orderIdValue);}catch(e){console.error('Inventory deduction after webhook failed:',e.message);}
        }
        else if(paymentStatus==='PENDING')await pool.query("UPDATE orders SET payment_status='pending' WHERE id=$1",[orderIdValue]);
        else if(paymentStatus==='FAILED')await pool.query("UPDATE orders SET payment_status='failed' WHERE id=$1",[orderIdValue]);
      }
      return json(res,200,{ok:true});
    }
    if(req.method==='GET'&&p.startsWith('/api/orders/')){
      const id=p.split('/').pop(),accessToken=u.searchParams.get('access_token');
      if(!accessToken)return json(res,401,{error:'Order access token required'});
      const r=await pool.query('SELECT id,created_at,items,total,payment_status,status,courier,tracking_number,dispatched_at,order_access_token FROM orders WHERE id=$1',[id]);
      if(!r.rowCount||r.rows[0].order_access_token!==accessToken)return json(res,404,{error:'Order not found'});
      const o=cachedOrderStatus(id,r.rows[0]);
      return json(res,200,{order:{id:o.id,createdAt:new Date(o.created_at).toISOString(),items:o.items,total:o.total,paymentStatus:o.payment_status,status:o.status,courier:o.courier||null,trackingNumber:o.tracking_number||null,dispatchedAt:o.dispatched_at?new Date(o.dispatched_at).toISOString():null}});
    }
    if(req.method==='GET'&&p==='/api/admin/orders'){
      if(!(await auth(req)))return json(res,401,{error:'Unauthorized'});
      const r=await pool.query('SELECT * FROM orders ORDER BY created_at ASC');
      return json(res,200,{orders:r.rows.map(rowOrder)});
    }
    if(req.method==='PATCH'&&p.startsWith('/api/admin/orders/')){
      if(!(await auth(req)))return json(res,401,{error:'Unauthorized'});
      const id=p.split('/').pop(),b=await body(req),o=await dbOrder(id);
      if(!o)return json(res,404,{error:'Order not found'});
      const allowed=['received','payment_confirmed','processing','dispatched','delivered','cancelled'];
      if(b.status&&!allowed.includes(b.status))return json(res,400,{error:'Invalid status'});
      if(b.status){
        if(b.status==='dispatched') await pool.query('UPDATE orders SET status=$1,dispatched_at=COALESCE(dispatched_at,NOW()) WHERE id=$2',[b.status,id]);
        else await pool.query('UPDATE orders SET status=$1 WHERE id=$2',[b.status,id]);
      }
      if(b.paymentStatus)await pool.query('UPDATE orders SET payment_status=$1 WHERE id=$2',[b.paymentStatus,id]);
      if(b.courier!==undefined)await pool.query('UPDATE orders SET courier=$1 WHERE id=$2',[String(b.courier||'').trim()||null,id]);
      if(b.trackingNumber!==undefined)await pool.query('UPDATE orders SET tracking_number=$1 WHERE id=$2',[String(b.trackingNumber||'').trim()||null,id]);
      orderStatusCache.delete(id);
      return json(res,200,{order:rowOrder(await dbOrder(id))});
    }
    if(req.method==='GET'&&p==='/api/admin/inventory'){
      if(!(await auth(req)))return json(res,401,{error:'Unauthorized'});
      return json(res,200,{products:await dbProducts(false)});
    }
    if(req.method==='PATCH'&&p.startsWith('/api/admin/products/')){
      if(!(await auth(req)))return json(res,401,{error:'Unauthorized'});
      const id=p.split('/').pop(),b=await body(req),r=await pool.query('SELECT * FROM products WHERE id=$1',[id]);
      if(!r.rowCount)return json(res,404,{error:'Product not found'});
      const allowed=['price','stock','active','name','pack'];
      const sets=[],vals=[];
      for(const k of allowed)if(b[k]!==undefined){sets.push(`${k}=$${vals.length+1}`);vals.push(b[k])}
      if(sets.length)await pool.query(`UPDATE products SET ${sets.join(',')} WHERE id=$${vals.length+1}`,[...vals,id]);
      const out=await pool.query('SELECT * FROM products WHERE id=$1',[id]);
      return json(res,200,{product:out.rows[0]});
    }
    return null;
  }catch(e){
    console.error(e);
    return json(res,500,{error:'Server error'});
  }
}
function serve(req,res){
  const requestPath=req.url.split('?')[0];
  let f=requestPath==='/'?'/index.html':requestPath;
  const file=path.normalize(path.join(ROOT,'public',f));
  if(!file.startsWith(path.join(ROOT,'public')))return json(res,403,{error:'Forbidden'});
  if(!fs.existsSync(file)||fs.statSync(file).isDirectory())return json(res,404,{error:'Not found'});
  const ext=path.extname(file),types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.xml':'application/xml; charset=utf-8','.txt':'text/plain; charset=utf-8'};
  const headers={'Content-Type':types[ext]||'application/octet-stream'};
  if(['.jpg','.jpeg','.png','.svg','.webp','.avif'].includes(ext))headers['Cache-Control']='public, max-age=604800, stale-while-revalidate=86400';
  res.writeHead(200,headers);fs.createReadStream(file).pipe(res);
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(),microphone=(),geolocation=()');
  if(req.url.startsWith('/api/')){const r=await api(req,res);if(r===null)json(res,404,{error:'API route not found'})}
  else serve(req,res);
});
async function start(){
  await initDb();
  server.listen(PORT,()=>console.log(`Rudraksha Farm running on http://localhost:${PORT}`));
}
const shutdown=async(signal)=>{
  console.log(signal+' received, shutting down');
  server.close(async()=>{try{await pool.end()}finally{process.exit(0)}});
  setTimeout(()=>process.exit(1),10000).unref();
};
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
start().catch(e=>{console.error('Startup failed:',e);process.exit(1)});
