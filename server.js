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
const OTP_PROVIDER=(process.env.OTP_PROVIDER||'').toLowerCase();
const OTP_API_URL=process.env.OTP_API_URL||'';
const OTP_API_KEY=process.env.OTP_API_KEY||'';
const CASHFREE_BASE_URL=CASHFREE_ENV==='production'?'https://api.cashfree.com/pg':'https://sandbox.cashfree.com/pg';

if(!DATABASE_URL)console.warn('DATABASE_URL is not configured');

const pool=new Pool({
  connectionString:DATABASE_URL||undefined,
  ssl:DATABASE_URL?{rejectUnauthorized:false}:false,
  max:5,
  idleTimeoutMillis:30000,
  connectionTimeoutMillis:10000
});

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
    CREATE TABLE IF NOT EXISTS customer_otp_challenges(
      phone TEXT PRIMARY KEY,
      otp_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS customers(
      phone TEXT PRIMARY KEY,
      name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS customer_sessions(
      token TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS inventory_deducted BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
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
    `INSERT INTO orders(id,created_at,customer,items,subtotal,shipping,total,payment_status,status,cashfree_order_id,cashfree_environment,payment_session_id)
     VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT(id) DO UPDATE SET customer=EXCLUDED.customer,items=EXCLUDED.items,subtotal=EXCLUDED.subtotal,shipping=EXCLUDED.shipping,total=EXCLUDED.total,payment_status=EXCLUDED.payment_status,status=EXCLUDED.status,cashfree_order_id=EXCLUDED.cashfree_order_id,cashfree_environment=EXCLUDED.cashfree_environment,payment_session_id=EXCLUDED.payment_session_id`,
    [o.id,o.createdAt,JSON.stringify(o.customer),JSON.stringify(o.items),o.subtotal,o.shipping,o.total,o.paymentStatus,o.status,o.cashfreeOrderId||null,o.cashfreeEnvironment||null,o.paymentSessionId||null]
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
  const r=await fetch(CASHFREE_BASE_URL+endpoint,{...options,headers:{'x-client-id':CASHFREE_APP_ID,'x-client-secret':CASHFREE_SECRET_KEY,'x-api-version':CASHFREE_API_VERSION,'Accept':'application/json','Content-Type':'application/json',...(options.headers||{})}});
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
  const products=await dbProducts(true);
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
function normalizePhone(v){let p=String(v||'').replace(/\\D/g,'');if(p.startsWith('91')&&p.length===12)p=p.slice(2);return p.length===10?p:null}
function otpHash(phone,otp){return crypto.createHash('sha256').update(String(phone)+':'+String(otp)+':'+SESSION_SECRET).digest('hex')}
async function sendOtpSms(phone,otp){
  if(!OTP_API_URL||!OTP_API_KEY)throw Error('OTP service is not configured. Add OTP_API_URL and OTP_API_KEY in Render environment variables.');
  const r=await fetch(OTP_API_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+OTP_API_KEY},body:JSON.stringify({phone:'+91'+phone,otp,message:'Your Rudraksha Farm login OTP is '+otp+'. It expires in 5 minutes.'})});
  if(!r.ok){const raw=await r.text();throw Error('Unable to send OTP'+(raw?' — '+raw.slice(0,180):''));}
}
async function customerAuth(req){const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return null;const r=await pool.query('SELECT phone FROM customer_sessions WHERE token=$1 AND expires_at>NOW()',[h.slice(7)]);return r.rowCount?r.rows[0].phone:null}
async function api(req,res){
  const u=new URL(req.url,`http://${req.headers.host}`),p=u.pathname;
  try{
    if(req.method==='GET'&&p==='/api/health')return json(res,200,{ok:true,service:'rudraksha-farm',database:Boolean(DATABASE_URL),time:new Date().toISOString()});
    if(req.method==='GET'&&p==='/api/products')return json(res,200,{products:(await dbProducts(true)).map(({id,name,pack,price,stock})=>({id,name,pack,price,available:Number.isInteger(stock)?stock>0:false}))});
    if(req.method==='POST'&&p==='/api/customer/request-otp'){
      const b=await body(req),phone=normalizePhone(b.phone);
      if(!phone)return json(res,400,{error:'Enter a valid 10-digit Indian mobile number'});
      const old=await pool.query('SELECT last_sent_at FROM customer_otp_challenges WHERE phone=$1',[phone]);
      if(old.rowCount&&Date.now()-new Date(old.rows[0].last_sent_at).getTime()<30000)return json(res,429,{error:'Please wait 30 seconds before requesting another OTP'});
      const otp=String(crypto.randomInt(100000,1000000));
      try{await sendOtpSms(phone,otp);}catch(e){return json(res,503,{error:e.message})}
      await pool.query('INSERT INTO customer_otp_challenges(phone,otp_hash,expires_at,attempts,last_sent_at) VALUES($1,$2,NOW()+INTERVAL \'5 minutes\',0,NOW()) ON CONFLICT(phone) DO UPDATE SET otp_hash=EXCLUDED.otp_hash,expires_at=EXCLUDED.expires_at,attempts=0,last_sent_at=NOW()',[phone,otpHash(phone,otp)]);
      return json(res,200,{ok:true,message:'OTP sent successfully',expiresIn:300});
    }
    if(req.method==='POST'&&p==='/api/customer/verify-otp'){
      const b=await body(req),phone=normalizePhone(b.phone),otp=String(b.otp||'').trim();
      if(!phone||!/^[0-9]{6}$/.test(otp))return json(res,400,{error:'Valid phone number and 6-digit OTP are required'});
      const r=await pool.query('SELECT * FROM customer_otp_challenges WHERE phone=$1',[phone]);
      if(!r.rowCount)return json(res,400,{error:'OTP expired or not requested'});
      const c=r.rows[0];if(new Date(c.expires_at).getTime()<Date.now())return json(res,400,{error:'OTP expired. Request a new OTP.'});
      if(c.attempts>=5)return json(res,429,{error:'Too many incorrect attempts. Request a new OTP.'});
      if(otpHash(phone,otp)!==c.otp_hash){await pool.query('UPDATE customer_otp_challenges SET attempts=attempts+1 WHERE phone=$1',[phone]);return json(res,401,{error:'Incorrect OTP'});}
      const t=token();
      await pool.query('INSERT INTO customers(phone,name,last_login_at) VALUES($1,$2,NOW()) ON CONFLICT(phone) DO UPDATE SET last_login_at=NOW()',[phone,String(b.name||'').trim()||null]);
      await pool.query('INSERT INTO customer_sessions(token,phone,expires_at) VALUES($1,$2,NOW()+INTERVAL \'30 days\')',[t,phone]);
      await pool.query('DELETE FROM customer_otp_challenges WHERE phone=$1',[phone]);
      return json(res,200,{token:t,phone:'+91'+phone});
    }
    if(req.method==='GET'&&p==='/api/customer/me'){
      const phone=await customerAuth(req);if(!phone)return json(res,401,{error:'Unauthorized'});
      const r=await pool.query('SELECT phone,name FROM customers WHERE phone=$1',[phone]);return json(res,200,{customer:r.rows[0]||{phone,name:null}});
    }
    if(req.method==='GET'&&p==='/api/customer/orders'){
      const phone=await customerAuth(req);if(!phone)return json(res,401,{error:'Unauthorized'});
      const r=await pool.query('SELECT id,created_at,items,total,payment_status,status,courier,tracking_number,dispatched_at FROM orders WHERE regexp_replace(COALESCE(customer->>\'phone\',\'\'), \'\\\\D\', \'\', \'g\')=$1 ORDER BY created_at DESC',[phone]);
      return json(res,200,{orders:r.rows.map(o=>({id:o.id,createdAt:new Date(o.created_at).toISOString(),items:o.items,total:o.total,paymentStatus:o.payment_status,status:o.status,courier:o.courier||null,trackingNumber:o.tracking_number||null,dispatchedAt:o.dispatched_at?new Date(o.dispatched_at).toISOString():null}))});
    }
    if(req.method==='POST'&&p==='/api/customer/logout'){
      const h=req.headers.authorization||'';if(h.startsWith('Bearer '))await pool.query('DELETE FROM customer_sessions WHERE token=$1',[h.slice(7)]);return json(res,200,{ok:true});
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
      const b=await body(req);
      if(!b.customer?.name||!b.customer?.phone||!b.customer?.address)return json(res,400,{error:'Customer name, phone and address are required'});
      let c;try{c=await calc(b.items)}catch(e){return json(res,400,{error:e.message})}
      const id=orderId(),customerId='rf_'+id.toLowerCase().replace(/[^a-z0-9]/g,'_');
      const payload={order_id:id,order_amount:Number(c.total.toFixed(2)),order_currency:'INR',customer_details:{customer_id:customerId,customer_name:b.customer.name,customer_phone:b.customer.phone,customer_email:b.customer.email||''},order_meta:{return_url:`${PUBLIC_BASE_URL||'http://localhost:'+PORT}/cashfree-return?order_id={order_id}`}};
      if(PUBLIC_BASE_URL)payload.order_meta.notify_url=`${PUBLIC_BASE_URL}/api/payments/cashfree/webhook`;
      try{
        const cf=await cashfreeFetch('/orders',{method:'POST',body:JSON.stringify(payload)});
        const o={id,createdAt:new Date().toISOString(),customer:b.customer,items:c.items,subtotal:c.subtotal,shipping:c.shipping,total:c.total,paymentStatus:'pending',status:'received',cashfreeOrderId:cf.order_id||id,cashfreeEnvironment:CASHFREE_ENV,paymentSessionId:cf.payment_session_id||null};
        await saveOrder(o);
        return json(res,201,{orderId:id,paymentSessionId:cf.payment_session_id,environment:CASHFREE_ENV,total:o.total});
      }catch(e){return json(res,e.status||502,{error:e.message,details:e.details||undefined})}
    }
    if(req.method==='GET'&&p==='/cashfree-return'){
      const id=u.searchParams.get('order_id');
      if(!id)return json(res,400,{error:'Missing order_id'});
      const o=await dbOrder(id);
      if(!o)return json(res,404,{error:'Order not found'});
      try{
        const payments=await cashfreeFetch(`/orders/${encodeURIComponent(o.cashfree_order_id||id)}/payments`,{method:'GET'});
        const success=Array.isArray(payments)&&payments.some(x=>x.payment_status==='SUCCESS');
        const pending=Array.isArray(payments)&&payments.some(x=>x.payment_status==='PENDING');
        if(success){
          await markOrderPaid(id);
        }else if(pending){
          await pool.query("UPDATE orders SET payment_status='pending' WHERE id=$1",[id]);
        }else{
          await pool.query("UPDATE orders SET payment_status='failed' WHERE id=$1",[id]);
        }
        res.writeHead(302,{Location:`/order.html?order_id=${encodeURIComponent(id)}`,'Cache-Control':'no-store'});
        return res.end();
      }catch(e){
        console.error('Cashfree return verification failed:',e.message);
        res.writeHead(302,{Location:`/order.html?order_id=${encodeURIComponent(id)}&verification=error`,'Cache-Control':'no-store'});
        return res.end();
      }
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
      const id=p.split('/').pop(),r=await pool.query('SELECT id,created_at,items,total,payment_status,status,courier,tracking_number,dispatched_at FROM orders WHERE id=$1',[id]);
      if(!r.rowCount)return json(res,404,{error:'Order not found'});
      const o=r.rows[0];
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
  if(req.url.startsWith('/api/')){const r=await api(req,res);if(r===null)json(res,404,{error:'API route not found'})}
  else serve(req,res);
});
async function start(){
  await initDb();
  server.listen(PORT,()=>console.log(`Rudraksha Farm running on http://localhost:${PORT}`));
}
start().catch(e=>{console.error('Startup failed:',e);process.exit(1)});
