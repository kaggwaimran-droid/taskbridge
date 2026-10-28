const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';
const secret = process.env.SESSION_SECRET;
if (production && (!secret || secret.length < 32)) throw new Error('Set SESSION_SECRET to at least 32 random characters.');
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, {recursive:true});
const db = new Database(path.join(dataDir, 'taskbridge.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec("CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,bio TEXT NOT NULL DEFAULT '',country TEXT NOT NULL DEFAULT '',role TEXT NOT NULL DEFAULT 'user',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,client_id INTEGER NOT NULL REFERENCES users(id),title TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,task_type TEXT NOT NULL DEFAULT 'Microtask',budget REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'USD',deadline TEXT,status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS applications(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,worker_id INTEGER NOT NULL REFERENCES users(id),message TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(task_id,worker_id)); CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,reporter_id INTEGER NOT NULL REFERENCES users(id),reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);");
const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const demoCount = db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
if (!demoCount) {
  const hash = bcrypt.hashSync('DemoPass123!', 10);
  db.prepare("INSERT OR IGNORE INTO users(name,email,password_hash,country) VALUES('TaskBridge Demo Client','demo-client@example.test',?,'Global')").run(hash);
  db.prepare("INSERT OR IGNORE INTO users(name,email,password_hash,bio,country) VALUES('TaskBridge Demo Worker','demo-worker@example.test',?,'Digital researcher and virtual assistant.','Global')").run(hash);
  const client = db.prepare("SELECT id FROM users WHERE email='demo-client@example.test'").get();
  const add = db.prepare('INSERT INTO tasks(client_id,title,description,category,task_type,budget,currency) VALUES(?,?,?,?,?,?,?)');
  add.run(client.id,'Research 10 sustainable packaging suppliers','Find ten suppliers, their websites and public contact pages. Deliver a spreadsheet with source links.','Research','Microtask',15,'USD');
  add.run(client.id,'Create social media graphics','Design three original square social graphics from a supplied brand brief. Include editable source files.','Design','Professional Service',60,'USD');
  add.run(client.id,'Build a simple landing page','Create a responsive landing page for a new service with clear sections and a contact call to action.','Development','Business Project',180,'USD');
}
if (adminEmail) db.prepare("UPDATE users SET role='admin' WHERE email=?").run(adminEmail);
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'30kb'}));
app.use(express.urlencoded({extended:false,limit:'30kb'}));
app.use(session({name:'taskbridge.sid',secret:secret || 'local-development-only-change-before-deploying',resave:false,saveUninitialized:false,store:new SQLiteStoreFactory({db:'sessions.sqlite',dir:dataDir}),cookie:{httpOnly:true,sameSite:'lax',secure:production,maxAge:604800000}}));
app.use(express.static(path.join(__dirname,'public')));
const authLimit = rateLimit({windowMs:900000,limit:30,standardHeaders:'draft-7',legacyHeaders:false});
const writeLimit = rateLimit({windowMs:60000,limit:40,standardHeaders:'draft-7',legacyHeaders:false});
const clean = (v,n=2000)=>String(v??'').trim().slice(0,n);
const emailOK = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
function me(req){if(!req.session.userId)return null;return db.prepare('SELECT id,name,email,bio,country,role,created_at FROM users WHERE id=?').get(req.session.userId)||null}
function auth(req,res,next){const u=me(req);if(!u)return res.status(401).json({error:'Please sign in to continue.'});req.user=u;next()}
function admin(req,res,next){if(!req.user||req.user.role!=='admin')return res.status(403).json({error:'Admin access required.'});next()}
const taskSelect = 'SELECT t.id,t.client_id,t.title,t.description,t.category,t.task_type,t.budget,t.currency,t.deadline,t.status,t.created_at,u.name client_name FROM tasks t JOIN users u ON u.id=t.client_id ';
app.get('/api/health',(req,res)=>res.json({ok:true,app:'TaskBridge MVP'}));
app.get('/api/me',(req,res)=>res.json({user:me(req)}));
app.post('/api/register',authLimit,async(req,res)=>{
 const name=clean(req.body.name,80),email=clean(req.body.email,254).toLowerCase(),password=String(req.body.password||''),country=clean(req.body.country,80);
 if(name.length<2)return res.status(400).json({error:'Please enter your name.'});
 if(!emailOK.test(email))return res.status(400).json({error:'Enter a valid email address.'});
 if(password.length<10||password.length>128)return res.status(400).json({error:'Use a password between 10 and 128 characters.'});
 try{const hash=await bcrypt.hash(password,12),role=adminEmail&&email===adminEmail?'admin':'user';const info=db.prepare('INSERT INTO users(name,email,password_hash,country,role) VALUES(?,?,?,?,?)').run(name,email,hash,country,role);req.session.userId=Number(info.lastInsertRowid);res.status(201).json({user:me(req)});}
 catch(e){if(String(e.code).includes('SQLITE_CONSTRAINT'))return res.status(409).json({error:'An account with that email already exists.'});res.status(500).json({error:'Could not create your account.'});}
});
app.post('/api/login',authLimit,async(req,res)=>{
 const email=clean(req.body.email,254).toLowerCase(),password=String(req.body.password||''),user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
 if(!user||!(await bcrypt.compare(password,user.password_hash)))return res.status(401).json({error:'Email or password is incorrect.'});
 if(adminEmail&&email===adminEmail&&user.role!=='admin')db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
 req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Could not start a secure session.'});req.session.userId=user.id;res.json({user:me(req)});});
});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('taskbridge.sid',{httpOnly:true,sameSite:'lax',secure:production});res.json({ok:true})}));
app.get('/api/tasks',(req,res)=>{
 const q=clean(req.query.q,100),category=clean(req.query.category,60),type=clean(req.query.type,60),status=clean(req.query.status,20)||'open';
 let sql=taskSelect+'WHERE t.status=?',args=[status];
 if(q){sql+=' AND (t.title LIKE ? OR t.description LIKE ? OR t.category LIKE ?)';args.push('%'+q+'%','%'+q+'%','%'+q+'%')}
 if(category&&category!=='All'){sql+=' AND t.category=?';args.push(category)}
 if(type&&type!=='All'){sql+=' AND t.task_type=?';args.push(type)}
 sql+=' ORDER BY t.created_at DESC LIMIT 100';
 res.json({tasks:db.prepare(sql).all(...args).map(t=>({...t,budget:Number(t.budget)}))});
});
app.get('/api/tasks/:id',(req,res)=>{
 const task=db.prepare(taskSelect+'WHERE t.id=?').get(Number(req.params.id));if(!task)return res.status(404).json({error:'Task not found.'});
 const user=me(req),applications=user&&(user.id===task.client_id||user.role==='admin')?db.prepare('SELECT a.id,a.worker_id,a.message,a.status,a.created_at,u.name worker_name,u.country worker_country FROM applications a JOIN users u ON u.id=a.worker_id WHERE a.task_id=? ORDER BY a.created_at DESC').all(task.id):undefined;
 const myApplication=user?db.prepare('SELECT id,status FROM applications WHERE task_id=? AND worker_id=?').get(task.id,user.id):null;
 res.json({task:{...task,budget:Number(task.budget)},applications,myApplication});
});
app.post('/api/tasks',auth,writeLimit,(req,res)=>{
 const title=clean(req.body.title,120),description=clean(req.body.description,3000),category=clean(req.body.category,60),type=clean(req.body.task_type,60),budget=Number(req.body.budget),currency=clean(req.body.currency||'USD',3).toUpperCase(),deadline=clean(req.body.deadline,10)||null;
 if(title.length<5||description.length<20)return res.status(400).json({error:'Add a title (5+ characters) and description (20+ characters).'});
 if(!['Microtask','Professional Service','Business Project','Remote Contract'].includes(type))return res.status(400).json({error:'Choose a valid task type.'});
 if(!['Research','Data Entry','Writing','Design','Development','Marketing','Admin Support','Other'].includes(category))return res.status(400).json({error:'Choose a valid category.'});
 if(!Number.isFinite(budget)||budget<1||budget>1000000)return res.status(400).json({error:'Budget must be between 1 and 1,000,000.'});
 if(!/^[A-Z]{3}$/.test(currency))return res.status(400).json({error:'Use a three-letter currency code.'});
 if(deadline&&!/^\\d{4}-\\d{2}-\\d{2}$/.test(deadline))return res.status(400).json({error:'Choose a valid deadline.'});
 const r=db.prepare('INSERT INTO tasks(client_id,title,description,category,task_type,budget,currency,deadline) VALUES(?,?,?,?,?,?,?,?)').run(req.user.id,title,description,category,type,budget,currency,deadline);
 res.status(201).json({id:Number(r.lastInsertRowid)});
});
app.patch('/api/tasks/:id',auth,writeLimit,(req,res)=>{
 const id=Number(req.params.id),t=db.prepare('SELECT * FROM tasks WHERE id=?').get(id);if(!t)return res.status(404).json({error:'Task not found.'});
 if(t.client_id!==req.user.id&&req.user.role!=='admin')return res.status(403).json({error:'You can only manage your own tasks.'});
 const status=clean(req.body.status,20);if(!['open','closed','in_progress','completed','removed'].includes(status))return res.status(400).json({error:'Invalid status.'});
 db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status,id);res.json({ok:true});
});
app.post('/api/tasks/:id/apply',auth,writeLimit,(req,res)=>{
 const id=Number(req.params.id),t=db.prepare('SELECT * FROM tasks WHERE id=?').get(id),message=clean(req.body.message,1200);
 if(!t||t.status!=='open')return res.status(404).json({error:'This task is not open for applications.'});
 if(t.client_id===req.user.id)return res.status(400).json({error:'You cannot apply to your own task.'});
 if(message.length<10)return res.status(400).json({error:'Write at least 10 characters about why you are a good fit.'});
 try{const r=db.prepare('INSERT INTO applications(task_id,worker_id,message) VALUES(?,?,?)').run(id,req.user.id,message);res.status(201).json({id:Number(r.lastInsertRowid)});}
 catch(e){if(String(e.code).includes('SQLITE_CONSTRAINT'))return res.status(409).json({error:'You have already applied to this task.'});res.status(500).json({error:'Could not submit your application.'})}
});
app.patch('/api/applications/:id',auth,(req,res)=>{
 const id=Number(req.params.id),status=clean(req.body.status,20);if(!['accepted','declined'].includes(status))return res.status(400).json({error:'Invalid application decision.'});
 const a=db.prepare('SELECT a.*,t.client_id,t.status task_status FROM applications a JOIN tasks t ON t.id=a.task_id WHERE a.id=?').get(id);
 if(!a)return res.status(404).json({error:'Application not found.'});
 if(a.client_id!==req.user.id&&req.user.role!=='admin')return res.status(403).json({error:'Only the task owner can review this application.'});
 if(a.task_status!=='open')return res.status(400).json({error:'This task is no longer open.'});
 db.transaction(()=>{db.prepare('UPDATE applications SET status=? WHERE id=?').run(status,id);if(status==='accepted'){db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(a.task_id);db.prepare("UPDATE applications SET status='declined' WHERE task_id=? AND id<>? AND status='pending'").run(a.task_id,id)}})();res.json({ok:true});
});
app.get('/api/dashboard',auth,(req,res)=>{
 const myTasks=db.prepare('SELECT t.id,t.title,t.category,t.task_type,t.budget,t.currency,t.status,t.created_at,(SELECT COUNT(*) FROM applications a WHERE a.task_id=t.id) application_count FROM tasks t WHERE t.client_id=? ORDER BY t.created_at DESC LIMIT 50').all(req.user.id);
 const myApplications=db.prepare('SELECT a.id,a.message,a.status,a.created_at,t.id task_id,t.title,t.budget,t.currency,t.status task_status,u.name client_name FROM applications a JOIN tasks t ON t.id=a.task_id JOIN users u ON u.id=t.client_id WHERE a.worker_id=? ORDER BY a.created_at DESC LIMIT 50').all(req.user.id);
 res.json({user:req.user,myTasks,myApplications});
});
app.patch('/api/profile',auth,(req,res)=>{
 const name=clean(req.body.name,80),bio=clean(req.body.bio,500),country=clean(req.body.country,80);if(name.length<2)return res.status(400).json({error:'Name must be at least 2 characters.'});
 db.prepare('UPDATE users SET name=?,bio=?,country=? WHERE id=?').run(name,bio,country,req.user.id);res.json({user:me(req)});
});
app.post('/api/tasks/:id/report',auth,writeLimit,(req,res)=>{
 const id=Number(req.params.id),reason=clean(req.body.reason,500);if(!db.prepare('SELECT id FROM tasks WHERE id=?').get(id))return res.status(404).json({error:'Task not found.'});
 if(reason.length<8)return res.status(400).json({error:'Explain the concern in at least 8 characters.'});
 db.prepare('INSERT INTO reports(task_id,reporter_id,reason) VALUES(?,?,?)').run(id,req.user.id,reason);res.status(201).json({ok:true});
});
app.get('/api/admin/overview',auth,admin,(req,res)=>res.json({
 stats:{users:db.prepare('SELECT COUNT(*) n FROM users').get().n,tasks:db.prepare('SELECT COUNT(*) n FROM tasks').get().n,openTasks:db.prepare("SELECT COUNT(*) n FROM tasks WHERE status='open'").get().n,reports:db.prepare("SELECT COUNT(*) n FROM reports WHERE status='open'").get().n},
 reports:db.prepare('SELECT r.id,r.reason,r.status,r.created_at,t.id task_id,t.title,u.name reporter_name FROM reports r JOIN tasks t ON t.id=r.task_id JOIN users u ON u.id=r.reporter_id ORDER BY r.created_at DESC LIMIT 100').all(),
 tasks:db.prepare('SELECT t.id,t.title,t.status,t.created_at,u.name client_name FROM tasks t JOIN users u ON u.id=t.client_id ORDER BY t.created_at DESC LIMIT 100').all()
}));
app.patch('/api/admin/reports/:id',auth,admin,(req,res)=>{const status=clean(req.body.status,20);if(!['reviewed','dismissed'].includes(status))return res.status(400).json({error:'Invalid report status.'});db.prepare('UPDATE reports SET status=? WHERE id=?').run(status,Number(req.params.id));res.json({ok:true})});
app.use('/api',(req,res)=>res.status(404).json({error:'API route not found.'}));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:'Something went wrong. Please try again.'})});
app.listen(PORT,'0.0.0.0',()=>console.log('TaskBridge MVP listening on port '+PORT));
