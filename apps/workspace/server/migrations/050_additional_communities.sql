-- Adds the communities requested for staff: teacher aides, cafeteria, maintenance, janitorial,
-- extended care, substitute teachers and IT. Each is an ordinary department with one starter job so
-- employees can be assigned and can clock in immediately. Administrators can rename or extend them later.
-- Idempotent: a community whose name already exists (any letter case) is left exactly as it is, and no
-- employee assignment, existing community, job or time record is changed.
WITH wanted(name,job_title) AS (VALUES
 ('Teacher Aides','Teacher aide'),
 ('Cafeteria','Cafeteria staff'),
 ('Maintenance','Maintenance technician'),
 ('Janitorial','Custodian'),
 ('Extended Care','Extended care staff'),
 ('Substitute Teachers','Substitute teacher'),
 ('IT','IT coordinator')
), created AS (
 INSERT INTO units(id,org_id,name,kind,description)
 SELECT gen_random_uuid(),o.id,w.name,'department',''
 FROM organizations o CROSS JOIN wanted w
 WHERE NOT EXISTS(SELECT 1 FROM units x WHERE x.org_id=o.id AND lower(x.name)=lower(w.name))
 RETURNING id,org_id,name
), starter_jobs AS (
 INSERT INTO jobs(id,org_id,unit_id,title)
 SELECT gen_random_uuid(),c.org_id,c.id,w.job_title FROM created c JOIN wanted w ON w.name=c.name
 RETURNING 1
)
INSERT INTO organization_structure_state(org_id,version)
SELECT org_id,count(*)::integer FROM created GROUP BY org_id
ON CONFLICT(org_id) DO UPDATE SET version=organization_structure_state.version+excluded.version;
