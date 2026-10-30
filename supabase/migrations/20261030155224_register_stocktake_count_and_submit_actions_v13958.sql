INSERT INTO public.permissions(key,description) VALUES
 ('action:stocktake:count','Record stocktake counts for authorized sessions and warehouse scope'),
 ('action:stocktake:submit','Submit a completed stocktake session for independent review')
ON CONFLICT(key) DO UPDATE SET description=EXCLUDED.description;
