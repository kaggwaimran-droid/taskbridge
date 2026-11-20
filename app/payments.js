const express=require('express');
const crypto=require('crypto');
module.exports=function(pool){
 const router=express.Router();
 const schema=pool.query(`
 CREATE TABLE IF NOT EXISTS task_payments(
  id BIGSERIAL PRIMARY KEY, task_id BIGINT NOT NULL REFERENCES tasks(id),
  submission_id BIGINT REFERENCES task_submissions(id),
  client_id BIGINT NOT NULL REFERENCES users(id), worker_id BIGINT NOT NULL REFERENCES users(id),
  tx_ref TEXT NOT NULL UNIQUE, provider_tx_id TEXT, amount NUMERIC(12,2) NOT NULL,
  currency VARCHAR(3) NOT NULL, commission NUMERIC(12,2) NOT NULL,
  worker_amount NUMERIC(12,2) NOT NULL, payment_method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', checkout_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), paid_at TIMESTAMPTZ
 );
 CREATE INDEX IF NOT EXISTS task_payments_client_idx ON task_payments(client_id,created_at DESC);
 CREATE INDEX IF NOT EXISTS task_payments_worker_idx ON task_payments(worker_id,created_at DESC);
 CREATE TABLE IF NOT EXISTS payment_ledger(
  id BIGSERIAL PRIMARY KEY, payment_id BIGINT NOT NULL REFERENCES task_payments(id),
  user_id BIGINT NOT NULL REFERENCES users(id), entry_type TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL, currency VARCHAR(3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE TABLE IF NOT EXISTS submission_earnings(
 id BIGSERIAL PRIMARY KEY, submission_id BIGINT NOT NULL UNIQUE REFERENCES task_submissions(id),
 task_id BIGINT NOT NULL REFERENCES tasks(id), client_id BIGINT NOT NULL REFERENCES users(id), worker_id BIGINT NOT NULL REFERENCES users(id),
 gross_amount NUMERIC(12,2) NOT NULL, platform_fee NUMERIC(12,2) NOT NULL, worker_net NUMERIC(12,2) NOT NULL,
 currency VARCHAR(3) NOT NULL, status TEXT NOT NULL DEFAULT 'pending_funding',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), funded_at TIMESTAMPTZ, paid_at TIMESTAMPTZ
); CREATE INDEX IF NOT EXISTS submission_earnings_worker_idx ON submission_earnings(worker_id,status,created_at DESC);
CREATE TABLE IF NOT EXISTS withdrawal_requests(
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id),
  amount NUMERIC(12,2) NOT NULL, currency VARCHAR(3) NOT NULL,
  network TEXT NOT NULL, phone_number TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'requested',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_by BIGINT REFERENCES users(id), reviewed_at TIMESTAMPTZ, payout_reference TEXT
 );
 ALTER TABLE task_payments ADD COLUMN IF NOT EXISTS submission_id BIGINT REFERENCES task_submissions(id);
 CREATE UNIQUE INDEX IF NOT EXISTS task_payments_active_submission_idx ON task_payments(submission_id) WHERE submission_id IS NOT NULL AND status IN ('pending','paid');
 ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS reviewed_by BIGINT REFERENCES users(id);
 ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
 ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS payout_reference TEXT;
 ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS withdrawal_fee NUMERIC(12,2) NOT NULL DEFAULT 0;
 ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS payout_amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
 router.use(async(req,res,next)=>{try{await schema;next()}catch(e){next(e)}});
 async function user(req){if(!req.session.userId)return null;return (await pool.query('SELECT id,name,email,role FROM users WHERE id=$1',[req.session.userId])).rows[0]||null}
 async function auth(req,res,next){try{req.user=await user(req);if(!req.user)return res.status(401).json({error:'Please sign in.'});next()}catch(e){next(e)}}
 router.get('/payments/summary',auth,async(req,res,next)=>{try{
  const [earn,paid,withdrawals,reserved,pendingEarnings,earningHistory]=await Promise.all([
   pool.query("SELECT currency,COALESCE(SUM(amount),0)::numeric AS total FROM payment_ledger WHERE user_id=$1 AND entry_type='worker_earning' GROUP BY currency",[req.user.id]),
   pool.query("SELECT currency,COALESCE(SUM(amount),0)::numeric AS total FROM task_payments WHERE client_id=$1 AND status='paid' GROUP BY currency",[req.user.id]),
   pool.query('SELECT id,amount,currency,network,phone_number,status,created_at FROM withdrawal_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.id]),
   pool.query("SELECT currency,COALESCE(SUM(amount),0)::numeric AS total FROM withdrawal_requests WHERE user_id=$1 AND status IN ('requested','processing','paid','completed') GROUP BY currency",[req.user.id]),
   pool.query("SELECT currency,COALESCE(SUM(worker_net),0)::numeric AS total FROM submission_earnings WHERE worker_id=$1 AND status='pending_funding' GROUP BY currency",[req.user.id]),
   pool.query("SELECT e.id,e.task_id,e.gross_amount,e.platform_fee,e.worker_net,e.currency,e.status,e.created_at,t.title FROM submission_earnings e JOIN tasks t ON t.id=e.task_id WHERE e.worker_id=$1 ORDER BY e.created_at DESC LIMIT 30",[req.user.id])
  ]);
  const reservedByCurrency=Object.fromEntries(reserved.rows.map(x=>[x.currency,Number(x.total)]));
  const available_balances=earn.rows.map(x=>({currency:x.currency,earned:Number(x.total),reserved:reservedByCurrency[x.currency]||0,available:Math.max(0,Number(x.total)-(reservedByCurrency[x.currency]||0))}));
  res.json({commission_rate:0.08,withdrawal_fee_rate:0.10,worker_earnings:earn.rows,client_payments:paid.rows,withdrawals:withdrawals.rows,available_balances,pending_submission_earnings:pendingEarnings.rows,earning_history:earningHistory.rows,live_payments_enabled:!!process.env.FLW_SECRET_KEY&&!!process.env.FLW_WEBHOOK_HASH});
 }catch(e){next(e)}});
 router.post('/tasks/:id/payment/checkout',auth,async(req,res,next)=>{try{
  if(!process.env.FLW_SECRET_KEY||!process.env.FLW_WEBHOOK_HASH)return res.status(503).json({error:'Payment provider is not configured yet. TaskBridge is not accepting real payments.'});
  const taskId=Number(req.params.id),submissionId=Number(req.body.submission_id),method=String(req.body.method||'card'),phone=String(req.body.phone_number||'').replace(/[^0-9]/g,'');
  if(!Number.isSafeInteger(taskId)||taskId<=0||!Number.isSafeInteger(submissionId)||submissionId<=0)return res.status(400).json({error:'Choose a valid approved submission to pay.'});
  const q=await pool.query("SELECT e.id AS earning_id,e.submission_id,e.task_id,e.client_id,e.worker_id,e.gross_amount,e.platform_fee,e.worker_net,e.currency,e.status AS earning_status,t.title,s.status AS submission_status,u.email AS worker_email FROM submission_earnings e JOIN tasks t ON t.id=e.task_id JOIN task_submissions s ON s.id=e.submission_id JOIN users u ON u.id=e.worker_id WHERE e.submission_id=$1 AND e.task_id=$2",[submissionId,taskId]);
  const e=q.rows[0];if(!e)return res.status(404).json({error:'Approved submission payment record not found.'});
  if(e.client_id!==req.user.id)return res.status(403).json({error:'Only the task owner can pay for this submission.'});
  if(e.submission_status!=='approved')return res.status(409).json({error:'Only approved work can be funded.'});
  if(e.earning_status!=='pending_funding')return res.status(409).json({error:'This submission is already funded or otherwise closed.'});
  if(!['card','mobile_money'].includes(method))return res.status(400).json({error:'Choose card or mobile money.'});
  const amount=Number(e.gross_amount),commission=Number(e.platform_fee),workerAmount=Number(e.worker_net);
  if(!Number.isFinite(amount)||amount<=0||Math.abs(amount-commission-workerAmount)>0.011)return res.status(409).json({error:'The submission payment amounts need administrator review.'});
  if(method==='mobile_money'&&(e.currency!=='UGX'||phone.length<9||!Number.isInteger(amount)))return res.status(400).json({error:'Uganda mobile money requires a valid phone number and a whole-number UGX amount.'});
  const existing=await pool.query("SELECT id,status FROM task_payments WHERE submission_id=$1 AND status IN ('pending','paid') ORDER BY created_at DESC LIMIT 1",[submissionId]);
  if(existing.rowCount)return res.status(409).json({error:existing.rows[0].status==='paid'?'This submission has already been paid.':'A payment is already pending for this submission.'});
  const txRef='TB-'+crypto.randomUUID();
  let inserted;
  try{inserted=await pool.query('INSERT INTO task_payments(task_id,submission_id,client_id,worker_id,tx_ref,amount,currency,commission,worker_amount,payment_method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[e.task_id,e.submission_id,e.client_id,e.worker_id,txRef,amount,e.currency,commission,workerAmount,method]);}
  catch(err){if(err.code==='23505')return res.status(409).json({error:'A payment is already pending or completed for this submission.'});throw err;}
  const base={amount,currency:e.currency,email:req.user.email,tx_ref:txRef,redirect_url:process.env.FLW_REDIRECT_URL||'https://taskbridge-uaka.onrender.com/marketplace/'};
  let endpoint='https://api.flutterwave.com/v3/payments',payload={...base,customer:{email:req.user.email,name:req.user.name},customizations:{title:'TaskBridge approved work payment',description:'Payment for: '+e.title}};
  if(method==='mobile_money'){
   endpoint='https://api.flutterwave.com/v3/charges?type=mobile_money_uganda';
   payload={...base,phone_number:phone,network:req.body.network==='AIRTEL'?'AIRTEL':'MTN',fullname:req.user.name};
  }
  const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+process.env.FLW_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await response.json();if(!response.ok||data.status!=='success'){await pool.query("UPDATE task_payments SET status='failed' WHERE id=$1",[inserted.rows[0].id]);return res.status(502).json({error:data.message||'Payment provider could not start checkout.'})}
  const url=data.data?.link||data.meta?.authorization?.redirect||null;
  if(!url&&method==='card'){await pool.query("UPDATE task_payments SET status='failed' WHERE id=$1",[inserted.rows[0].id]);return res.status(502).json({error:'The payment provider did not return a secure checkout link.'});}
  await pool.query('UPDATE task_payments SET checkout_url=$1,provider_tx_id=$2 WHERE id=$3',[url,data.data?.id?String(data.data.id):null,inserted.rows[0].id]);
  res.status(201).json({tx_ref:txRef,checkout_url:url,status:'pending',amount,currency:e.currency,commission,worker_amount:workerAmount,submission_id:submissionId});
 }catch(e){next(e)}});
 router.post('/payments/webhook',async(req,res,next)=>{try{
  const supplied=req.headers['verif-hash'];const expected=String(process.env.FLW_WEBHOOK_HASH||'');if(!supplied||!expected||String(supplied).length!==expected.length||!crypto.timingSafeEqual(Buffer.from(String(supplied)),Buffer.from(expected)))return res.sendStatus(401);
  const event=req.body?.event,d=req.body?.data||{};if(event!=='charge.completed'||!d.id||!d.tx_ref)return res.sendStatus(200);
  const p=(await pool.query('SELECT * FROM task_payments WHERE tx_ref=$1',[d.tx_ref])).rows[0];if(!p||!p.submission_id||p.status==='paid')return res.sendStatus(200);
  const vr=await fetch('https://api.flutterwave.com/v3/transactions/'+encodeURIComponent(d.id)+'/verify',{headers:{Authorization:'Bearer '+process.env.FLW_SECRET_KEY}});
  const verified=await vr.json(),v=verified.data;
  if(!vr.ok||verified.status!=='success'||v?.status!=='successful'||v?.tx_ref!==p.tx_ref||v?.currency!==p.currency||Number(v?.amount)!==Number(p.amount))return res.sendStatus(200);
  const c=await pool.connect();try{
   await c.query('BEGIN');
   const locked=(await c.query('SELECT * FROM task_payments WHERE id=$1 FOR UPDATE',[p.id])).rows[0];
   if(locked.status!=='paid'){
    const earning=(await c.query("SELECT * FROM submission_earnings WHERE submission_id=$1 AND status='pending_funding' FOR UPDATE",[locked.submission_id])).rows[0];
    if(!earning||Number(earning.gross_amount)!==Number(locked.amount)||Number(earning.platform_fee)!==Number(locked.commission)||Number(earning.worker_net)!==Number(locked.worker_amount)||earning.client_id!==locked.client_id||earning.worker_id!==locked.worker_id)throw new Error('Payment-to-submission reconciliation failed; payment was not credited.');
    await c.query("UPDATE task_payments SET status='paid',provider_tx_id=$1,paid_at=NOW() WHERE id=$2",[String(d.id),locked.id]);
    await c.query("UPDATE submission_earnings SET status='funded',funded_at=NOW() WHERE submission_id=$1",[locked.submission_id]);
    await c.query('INSERT INTO payment_ledger(payment_id,user_id,entry_type,amount,currency) VALUES($1,$2,$3,$4,$5),($1,$6,$7,$8,$5)',[locked.id,locked.client_id,'client_payment',-locked.amount,locked.currency,locked.worker_id,'worker_earning',locked.worker_amount]);
    await c.query('INSERT INTO payment_ledger(payment_id,user_id,entry_type,amount,currency) VALUES($1,$2,$3,$4,$5)',[locked.id,locked.client_id,'platform_commission',locked.commission,locked.currency]);
   }
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  res.sendStatus(200);
 }catch(e){next(e)}});
 router.get('/payments/admin/withdrawals',auth,async(req,res,next)=>{try{
  if(req.user.role!=='admin')return res.status(403).json({error:'Admin access required.'});
  const q=await pool.query("SELECT w.id,w.user_id,u.name AS worker_name,u.email AS worker_email,w.amount,w.withdrawal_fee,w.payout_amount,w.currency,w.network,w.phone_number,w.status,w.payout_reference,w.created_at,w.reviewed_at FROM withdrawal_requests w JOIN users u ON u.id=w.user_id ORDER BY CASE WHEN w.status='requested' THEN 0 WHEN w.status='processing' THEN 1 ELSE 2 END,w.created_at ASC LIMIT 100");
  res.json({withdrawals:q.rows});
 }catch(e){next(e)}});
 router.patch('/payments/admin/withdrawals/:id',auth,async(req,res,next)=>{const c=await pool.connect();try{
  if(req.user.role!=='admin')return res.status(403).json({error:'Admin access required.'});
  const status=String(req.body.status||''),reference=String(req.body.payout_reference||'').trim().slice(0,120);
  if(!['processing','paid','rejected'].includes(status))return res.status(400).json({error:'Choose processing, paid or rejected.'});
  if(status==='paid'&&!reference)return res.status(400).json({error:'Add the actual payout reference before marking this withdrawal paid.'});
  await c.query('BEGIN');
  const w=(await c.query('SELECT * FROM withdrawal_requests WHERE id=$1 FOR UPDATE',[Number(req.params.id)])).rows[0];
  if(!w){await c.query('ROLLBACK');return res.status(404).json({error:'Withdrawal request not found.'});}
  if(!['requested','processing'].includes(w.status)){await c.query('ROLLBACK');return res.status(409).json({error:'This withdrawal has already been closed.'});}
  await c.query('UPDATE withdrawal_requests SET status=$1,reviewed_by=$2,reviewed_at=NOW(),payout_reference=$3 WHERE id=$4',[status,req.user.id,status==='paid'?reference:null,w.id]);
  await c.query('COMMIT');res.json({ok:true,status,message:status==='paid'?'Payout marked paid. Confirm the transfer was actually sent.':'Withdrawal request updated.'});
 }catch(e){try{await c.query('ROLLBACK')}catch(_){}next(e)}finally{c.release()}});
 router.post('/payments/withdrawals',auth,async(req,res,next)=>{try{
  const amount=Number(req.body.amount),currency=String(req.body.currency||'UGX').toUpperCase(),network=String(req.body.network||''),phone=String(req.body.phone_number||'').replace(/[^0-9]/g,'');
  const withdrawalFee=Number((amount*0.10).toFixed(2)),payoutAmount=Number((amount-withdrawalFee).toFixed(2));
  if(currency!=='UGX'||!['MTN','AIRTEL'].includes(network)||phone.length<9||!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Uganda withdrawals require a valid UGX amount, MTN or AIRTEL network and mobile number.'});
  const c=await pool.connect();let q;
  try{
   await c.query('BEGIN');
   await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
   const bal=await c.query("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM payment_ledger WHERE user_id=$1 AND entry_type='worker_earning'",[req.user.id]);
   const reserved=await c.query("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM withdrawal_requests WHERE user_id=$1 AND status IN ('requested','processing','paid','completed')",[req.user.id]);
   if(Number(bal.rows[0].total)-Number(reserved.rows[0].total)<amount){await c.query('ROLLBACK');return res.status(400).json({error:'Insufficient available earnings.'});}
   q=await c.query("INSERT INTO withdrawal_requests(user_id,amount,currency,network,phone_number,withdrawal_fee,payout_amount) VALUES($1,$2,'UGX',$3,$4,$5,$6) RETURNING id,status,amount,withdrawal_fee,payout_amount",[req.user.id,amount,network,phone,withdrawalFee,payoutAmount]);
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  res.status(201).json({withdrawal:q.rows[0],fee_rate:0.10,withdrawal_fee:withdrawalFee,payout_amount:payoutAmount,message:'Withdrawal request recorded. The 10% withdrawal fee has been shown separately; payouts are not automated until provider approval and payout credentials are configured.'});
 }catch(e){next(e)}});
 return router;
};