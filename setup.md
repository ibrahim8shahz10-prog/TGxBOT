1. Create bot on @BotFather → get BOT_TOKEN
2. Create Supabase project → run schema.sql in SQL Editor
3. Get Supabase URL and service_role key from Project Settings > API
4. Push all files to GitHub
5. Go to Vercel → Import GitHub repo
6. Add environment variables:
   BOT_TOKEN = your token
   BOT_USERNAME = your bot username (no @)
   SUPABASE_URL = your url
   SUPABASE_SERVICE_ROLE_KEY = your key
7. Deploy → copy your Vercel URL
8. Set webhook by opening this in browser:
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://your-vercel-url.vercel.app/api/webhook
9. Add yourself as admin — run this in Supabase SQL Editor:
   INSERT INTO admins (telegram_id) VALUES (YOUR_TELEGRAM_ID);
10. Run this SQL function in Supabase:
    CREATE OR REPLACE FUNCTION increment_credits(user_tid bigint, amount int)
    RETURNS void AS $$
      UPDATE users SET credits = credits + amount WHERE telegram_id = user_tid;
    $$ LANGUAGE sql;
