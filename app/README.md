# TaskBridge MVP

**Connecting People. Creating Opportunities.**

This is a separate full-stack MVP in the \`app/\` folder. The existing root \`index.html\` homepage is unchanged.

## Run in Replit
1. Import GitHub repository \`kaggwaimran-droid/taskbridge\` into Replit.
2. Set the working directory/run command to \`cd app && npm start\` (or open the \`app\` folder as the project).
3. Set Secrets: \`SESSION_SECRET\` to a long random string, \`ADMIN_EMAIL\` to your owner email, and \`NODE_ENV=production\` for deployment.
4. Run \`npm install\` and \`npm start\` from the app folder.
5. Register using the \`ADMIN_EMAIL\` address to receive admin access.

## Features
- Registration/login with bcrypt password hashing and SQLite-backed user/task/application/report data.
- Persistent SQLite-backed sessions.
- Worker and Client modes on one account.
- Task discovery, search and categories; task posting and status management.
- Worker applications; clients can accept or decline applicants.
- Profile editing, task reports and basic admin moderation.
- Responsive black dark mode and warm light mode with blue/white/gold branding.

## Not ready for public launch
No payment processing, escrow, identity verification, email verification, password reset, messaging, dispute resolution or automated fraud detection. Do not collect sensitive identity documents or payment information. Set secrets before deployment and test the app. Add backups, monitoring, email verification, password reset, abuse controls, terms/privacy policy and a reviewed payment integration before accepting real users.

GitHub Pages can only host the static root homepage; this backend requires a Node.js host that supports a persistent server and SQLite storage. This app remains separate under \`app/\`.
