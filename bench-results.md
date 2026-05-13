
════════════════════════════════════════════════════════════════════
  MAXX BENCH  — 25 prompts through the semantic graph pipeline
════════════════════════════════════════════════════════════════════

  model: qwen3:1.7b

────────────────────────────────────────────────────────────────────
   1/25  Write     97%  ICS 51

  IN   "hey claude help me word this so i dont sound mad"

  OUT  i don't sound mad.

────────────────────────────────────────────────────────────────────
   2/25  Write     47%  ICS 47

  IN   "i need to send something to my boss about being late can you help"

  OUT  Subject: Regarding Being Late  
       
       Dear Boss,  
       
       I apologize for being late. I will make sure to be on time in the future.  
       
       Best,  
       [Your Name]

────────────────────────────────────────────────────────────────────
   3/25  Write     42%  ICS 45

  IN   "write something for the team meeting announcement tomorrow"

  OUT  Tomorrow, we will hold a team meeting. Please attend promptly.

────────────────────────────────────────────────────────────────────
   4/25  Write     76%  ICS 56

  IN   "can you help me reply to this angry client email without being too aggressive"

  OUT  Dear [Client's Name],  
       
       We apologize for the inconvenience caused. We understand your frustration and are committed to resolving this issue promptly. Please provide any additional details you would like us to consider. We appreciate your patience and will do our best to address your concerns.  
       
       Best regards,  
       [Your Name]  
       [Your Position]  
       [Your Company]

────────────────────────────────────────────────────────────────────
   5/25  Write     69%  ICS 52

  IN   "help me ask for a raise its been 2 years and honestly i deserve one"

  OUT  Dear [Manager's Name],  
       I hope this message finds you well. I wanted to ask if you could consider a raise for me after two years of service. Thank you.

────────────────────────────────────────────────────────────────────
   6/25  Decide    100%  ICS 70

  IN   "should i use postgres or sqlite honestly not sure which is better for my app"

  OUT  Use PostgreSQL for a more robust and scalable solution, while SQLite is suitable for simple, lightweight applications. Consider your app's requirements, such as scalability, complexity, and data integrity.

────────────────────────────────────────────────────────────────────
   7/25  Decide    65%  ICS 35

  IN   "is react or vue better"

  OUT  React is better for single-page applications and large-scale projects, while Vue is better for smaller applications and simpler use cases.

────────────────────────────────────────────────────────────────────
   8/25  Decide    40%  ICS 45

  IN   "help me decide if i should take this job offer or stay where i am"

  OUT  recommendation: accept the job offer

────────────────────────────────────────────────────────────────────
   9/25  Fix       41%  ICS 34

  IN   "my code is broken fix it"

  OUT  code

────────────────────────────────────────────────────────────────────
  10/25  Fix       70%  ICS 41

  IN   "the app keeps crashing randomly and i dont know why"

  OUT  [needs: error description] — What are the error description?

────────────────────────────────────────────────────────────────────
  11/25  Fix       43%  ICS 20

  IN   "something is wrong with the auth and users cant log in anymore"

  OUT  [needs: error description] — What are the error description?

────────────────────────────────────────────────────────────────────
  12/25  Fix       100%  ICS 60

  IN   "my api responses are really slow lately and it wasnt like this before"

  OUT  [needs: error description] — What are the error description?

────────────────────────────────────────────────────────────────────
  13/25  Plan      43%  ICS 28

  IN   "help me plan my project"

  OUT  plan (medium)

────────────────────────────────────────────────────────────────────
  14/25  Plan      38%  ICS 33

  IN   "i need a roadmap for launching this feature soon"

  OUT  Plan: Develop and implement the feature according to the roadmap, ensuring all requirements are met and the application is updated accordingly.

────────────────────────────────────────────────────────────────────
  15/25  Plan      63%  ICS 46

  IN   "help me figure out how to approach this migration"

  OUT  1. Assess the current database structure and requirements.
       2. Identify the target database system (e.g., PostgreSQL, MySQL, SQL Server).
       3. Determine the migration tools or methods (e.g., import/export, ETL, database cloning).
       4. Back up the source database to prevent data loss.
       5. Use a migration tool to export data from the source database.
       6. Import the data into the target database.
       7. Test the migrated data to ensure integrity and functionality.
       8. Monitor the migration process for any errors or issues.
       9. Restore the original database configuration after migration.
       10. Document the migration process and results.

────────────────────────────────────────────────────────────────────
  16/25  Write     8%  ICS 16

  IN   "tell me about machine learning"

  OUT  [unclear 8%] — What is the single most important outcome you need?

────────────────────────────────────────────────────────────────────
  17/25  Decide    64%  ICS 46

  IN   "what should i use for my database"

  OUT  [needs: explicit options] — What are the options or ideas?

────────────────────────────────────────────────────────────────────
  18/25  Create    85%  ICS 40

  IN   "make me some social media posts"

  OUT  Post 1: "Just got hired at a cool startup! 🚀 Can't wait to grow with the best team. #NewBeginnings #WorkLifeBalance"
       
       Post 2: "Love the vibe here! 🌟 From the first day, it's clear this place is all about innovation and support. #WorkFromHome #Innovation"
       
       Post 3: "New to the game, but already feeling excited. 🎉 This community is amazing. #StartHere #CommunityMatters"

────────────────────────────────────────────────────────────────────
  19/25  Create    71%  ICS 53

  IN   "give me ideas for the landing page"

  OUT  1. Hero section with app logo and tagline  
       2. Features section with icons and brief descriptions  
       3. Testimonials section with user quotes  
       4. Call to action button (e.g., "Get Started")  
       5. Footer with contact info and links

────────────────────────────────────────────────────────────────────
  20/25  Write     47%  ICS 47

  IN   "write a bio for my linkedin or something"

  OUT  [Your Name]  
       [Your Profession] | [Your Location]  
        passionate [insert interest] | committed to [insert value proposition]  
       
       [Your Professional Summary]  
       [Your Professional Summary]  
       [Your Professional Summary]

────────────────────────────────────────────────────────────────────
  21/25  Learn     37%  ICS 39

  IN   "explain how oauth works basically i dont really understand it"

  OUT  OAuth is a protocol that allows applications to secure web resources on behalf of a user. It works by:
       
       1. **User Authorization**: The user allows the application to access their account.
       2. **Token Issuance**: The user's authorization is confirmed, and a token is issued.
       3. **Access**: The application uses the token to access the user's resources.

────────────────────────────────────────────────────────────────────
  22/25  Learn     88%  ICS 60

  IN   "i want to understand docker but honestly never really got it"

  OUT  Docker is a tool that allows you to package applications into containers, making it easy to develop, test, and deploy applications across different environments. It simplifies software distribution by isolating applications from their environment.

────────────────────────────────────────────────────────────────────
  23/25  Extract   100%  ICS 55

  IN   "get the important stuff from my notes"

  OUT  - Important notes from your notes  
       - Key information extracted  
       - Critical points highlighted

────────────────────────────────────────────────────────────────────
  24/25  Extract   100%  ICS 60

  IN   "pull out the main points from this meeting"

  OUT  [needs: source material] — What are the source text?

────────────────────────────────────────────────────────────────────
  25/25  Organize  40%  ICS 29

  IN   "organize everything its a total mess"

  OUT  outline

════════════════════════════════════════════════════════════════════

