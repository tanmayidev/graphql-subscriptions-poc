-- CREATE DATABASE example;

\c example;

CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id UUID,
    message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO notifications (user_id, message) VALUES
('458f23f1-b27f-4c56-8da6-10508f9c5366', 'Special Notification 1'),
('f7ef9e4a-01e5-495a-8b69-662646c308b2', 'Special Notification 2'),
('eecfc6be-1585-4b13-96b4-285abf4be5e8', 'Special Notification 3');

CREATE FUNCTION notify_new_notification()
RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('new_notification', json_build_object(
        'id', NEW.id,
        'user_id', NEW.user_id,
        'message', NEW.message,
        'created_at', NEW.created_at
    )::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER new_notification_trigger
AFTER INSERT ON notifications
FOR EACH ROW EXECUTE FUNCTION notify_new_notification();