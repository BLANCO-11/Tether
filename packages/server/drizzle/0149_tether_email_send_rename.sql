-- Rebrand: the built-in email tool is now tether_email_send. Only the tools table stores the name as data.
UPDATE tools SET name = 'tether_email_send' WHERE name = 'foundry_email_send';
