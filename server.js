const express = require('express');
const cors = require('cors');
const axios = require('axios');
const neo4j = require('neo4j-driver');

const app = express();
app.use(cors());
app.use(express.json());

// IMPORTANT: CONNECTION SETTINGS
// 1. Protocol: "neo4j+s" enables full encryption (Required for remote HTTPS servers)
// 2. Host: neo4j-2.g-scop.grenoble-inp.fr
// 3. Port: 7687 (Standard Bolt port)
// FIX: Removed the configuration object because "neo4j+s" implies encryption.
const driver = neo4j.driver(
    "bolt+ssc://neo4j-2.g-scop.grenoble-inp.fr:7687",
    neo4j.auth.basic("pinquier", "pinquier")
);

// Test connection on startup
const verifyConnection = async () => {
    try {
        await driver.verifyConnectivity();
        console.log('✅ Connected to Neo4j at neo4j-2.g-scop.grenoble-inp.fr');
    } catch (error) {
        console.error('❌ Neo4j Connection Failed:', error.message);
        if (error.message.includes("certificate")) {
            console.log('HINT: If using a self-signed cert, try changing "neo4j+s://" to "neo4j+ssc://"');
        }
    }
};
verifyConnection();

// --- MAPS ---

app.get('/maps', async (req, res) => {
    const session = driver.session();
    try {
        // Ensure Root Exists then fetch Maps linked to it
        await session.run(`MERGE (:RootNode {name: "Maps"})`);
        const result = await session.run(`
            MATCH (:RootNode {name: "Maps"})-[:HAS_MAP]->(m:Map) 
            RETURN m.name ORDER BY m.name
        `);
        const maps = result.records.map(r => r.get('m.name'));
        res.json(maps);
    } catch (err) {
        console.error("Database Error:", err);
        res.status(500).json({ error: "Neo4j error" });
    } finally { session.close(); }
});

app.post('/maps', async (req, res) => {
    const { name, password } = req.body;
    const session = driver.session();

    if (!password) return res.status(400).json({ error: "Password required" });

    try {
        // Link new Map to Root Node "Maps"
        await session.run(`
            MERGE (root:RootNode {name: "Maps"})
            MERGE (m:Map {name: $name})
            MERGE (root)-[:HAS_MAP]->(m)
            ON CREATE SET m.password = $password
        `, { name, password });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Neo4j error" });
    } finally { session.close(); }
});

app.delete('/maps', async (req, res) => {
    const { name, password } = req.body;
    const session = driver.session();
    try {
        const result = await session.run(`MATCH (m:Map {name: $name}) RETURN m.password as pwd`, { name });
        if (result.records.length === 0) return res.status(404).json({ error: "Map not found" });

        const storedPassword = result.records[0].get('pwd');
        if (storedPassword && storedPassword !== password) {
            return res.status(403).json({ error: "Incorrect password" });
        }

        // Cascading delete
        await session.run(`MATCH (n:Factor {mapName: $name}) DETACH DELETE n`, { name });
        await session.run(`MATCH (m:Map {name: $name}) DETACH DELETE m`, { name });

        res.json({ success: true });
    } catch (err) {
        console.error("Delete map error:", err);
        res.status(500).json({ error: "Neo4j delete error" });
    } finally { session.close(); }
});

// --- GRAPH DATA (Evidence Map) ---

app.post('/graph', async (req, res) => {
    const { mapName, password } = req.body;
    const session = driver.session();

    if (!mapName) return res.json({ elements: [] });

    try {
        const authRes = await session.run(`MATCH (m:Map {name: $mapName}) RETURN m.password as pwd`, { mapName });
        if (authRes.records.length === 0) return res.status(404).json({ error: "Map not found" });

        const storedPwd = authRes.records[0].get('pwd');
        if (storedPwd && storedPwd !== password) {
            return res.status(403).json({ error: "Incorrect password" });
        }

        const query = `
            MATCH (n:Factor {mapName: $mapName})
            OPTIONAL MATCH (n)-[r:EVIDENCE]->(t:Factor {mapName: $mapName})
            RETURN n, r, t
        `;

        const result = await session.run(query, { mapName });
        const elements = [];
        const nodes = new Map();

        result.records.forEach(record => {
            const n = record.get('n');
            const r = record.get('r');
            const t = record.get('t');

            if (!nodes.has(n.properties.name)) {
                nodes.set(n.properties.name, true);
                elements.push({ data: { id: n.properties.name, label: n.properties.name, definition: n.properties.definition || "" } });
            }

            if (r && t) {
                if (!nodes.has(t.properties.name)) {
                    nodes.set(t.properties.name, true);
                    elements.push({ data: { id: t.properties.name, label: t.properties.name, definition: t.properties.definition || "" } });
                }
                elements.push({
                    group: 'edges',
                    data: {
                        source: n.properties.name, target: t.properties.name,
                        label: `(${r.properties.author}, ${r.properties.year})`, ...r.properties,
                    }
                });
            }
        });
        res.json({ elements });
    } catch (err) {
        console.error("Error fetching graph:", err);
        res.status(500).json({ error: "Neo4j read error" });
    } finally { session.close(); }
});

app.post('/save-relationship', async (req, res) => {
    const { source, target, metadata, level, causality, mapName } = req.body;
    const session = driver.session();

    try {
        await session.run(
            `
            MATCH (m:Map {name: $mapName})
            MERGE (s:Factor {name: $source, mapName: $mapName})
            MERGE (t:Factor {name: $target, mapName: $mapName})
            MERGE (s)-[:BELONGS_TO]->(m)
            MERGE (t)-[:BELONGS_TO]->(m)
            MERGE (s)-[r:EVIDENCE {doi: $metadata.doi}]->(t)
            ON CREATE SET r.title = $metadata.title, r.author = $metadata.author, r.year = $metadata.year, r.journal = $metadata.journal, r.level = $level, r.causality = $causality, r.notes = ""
            ON MATCH SET r.level = $level, r.causality = $causality
            RETURN s, r, t
            `,
            { source, target, metadata, level, causality: causality || "", mapName }
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Write error" }); } finally { session.close(); }
});

app.post('/relationship/update', async (req, res) => {
    const { source, target, doi, level, causality, notes, mapName } = req.body;
    const session = driver.session();
    try {
        await session.run(
            `MATCH (s:Factor {name: $source, mapName: $mapName})-[r:EVIDENCE]->(t:Factor {name: $target, mapName: $mapName}) 
             WHERE r.doi = $doi 
             SET r.level = $level, r.causality = $causality, r.notes = $notes 
             RETURN r`,
            { source, target, doi, level, causality, notes, mapName }
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Error" }); } finally { session.close(); }
});

app.post('/node/rename', async (req, res) => {
    const { oldName, newName, mapName } = req.body;
    const session = driver.session();
    try {
        await session.run(`MATCH (n:Factor {name: $oldName, mapName: $mapName}) SET n.name = $newName RETURN n`, { oldName, newName, mapName });
        res.json({ success: true, newName });
    } catch (err) { res.status(500).json({ error: "Error" }); } finally { session.close(); }
});

app.post('/node/definition', async (req, res) => {
    const { name, definition, mapName } = req.body;
    const session = driver.session();
    try {
        await session.run(`MATCH (n:Factor {name: $name, mapName: $mapName}) SET n.definition = $definition`, { name, definition, mapName });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Error" }); } finally { session.close(); }
});

app.delete('/relationship', async (req, res) => {
    const { source, target, doi, mapName } = req.body;
    const session = driver.session();
    try {
        await session.run(`MATCH (s:Factor {name: $source, mapName: $mapName})-[r:EVIDENCE]->(t:Factor {name: $target, mapName: $mapName}) WHERE r.doi = $doi DELETE r`, { source, target, doi, mapName });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Neo4j delete error" }); } finally { session.close(); }
});

app.delete('/node', async (req, res) => {
    const { name, mapName } = req.body;
    const session = driver.session();
    try {
        await session.run(`MATCH (n:Factor {name: $name, mapName: $mapName}) DETACH DELETE n`, { name, mapName });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Delete error" }); } finally { session.close(); }
});


// --- RESOURCES MATRIX ACTIONS ---

// SAVE: Constructs the specific hierarchy requested
app.post('/quality/matrix/save', async (req, res) => {
    const { type, matrix } = req.body;
    const session = driver.session();

    try {
        // 1. Create/Merge Research Class
        await session.run(`MERGE (rc:ResearchClass {name: $type})`, { type });

        // 2. Process Rows (Research Designs)
        for (const row of matrix.rows) {
            await session.run(`
                MATCH (rc:ResearchClass {name: $type})
                MERGE (rdc:ResearchDesignClass {name: $level1}) 
                MERGE (rc)-[:HAS_DESIGN_CLASS]->(rdc)
                
                MERGE (rdGroup:ResearchDesigns {name: "Research Designs"})
                MERGE (rdc)-[:LINKED_TO]->(rdGroup)
                
                MERGE (cat:ResearchDesignCategory {name: $level2}) 
                MERGE (rdGroup)-[:HAS_CATEGORY]->(cat)
                
                MERGE (sub:ResearchDesignSubCategory {id: $id})
                SET sub.name = $name, sub.definition = $def, sub.risks = $risks, sub.order = $order
                MERGE (cat)-[:HAS_SUB_CATEGORY]->(sub)
                SET cat.definition = $catDef
            `, {
                type, level1: row.level1, level2: row.level2, id: row.id,
                name: row.name, risks: row.risks || "", def: row.definition || "",
                catDef: row.catDefinition || "", order: row.order || 0
            });
        }

        // 3. Process Columns (Data Collection Techniques)
        for (const col of matrix.cols) {
            const distinctLevels = [...new Set(matrix.rows.map(r => r.level1))];
            for (const level1 of distinctLevels) {
                await session.run(`
                    MATCH (rdc:ResearchDesignClass {name: $level1})
                    MERGE (dctGroup:DataCollectionsTechniques {name: "Data Collections Techniques"})
                    MERGE (rdc)-[:LINKED_TO]->(dctGroup)
                    
                    MERGE (dct:DataCollectionTechnique {id: $id})
                    SET dct.name = $name, dct.risks = $risks, dct.order = $order
                    MERGE (dctGroup)-[:HAS_TECHNIQUE]->(dct)
                `, { level1, id: col.id, name: col.name, risks: col.risks || "", order: col.order || 0 });
            }
        }

        // 4. Process Data (Research Methods at Intersection)
        for (const [key, val] of Object.entries(matrix.data)) {
            const [rid, cid] = key.split('_');

            await session.run(`
                MATCH (sub:ResearchDesignSubCategory {id: $rid})-[rel:HAS_METHOD]->(rm:ResearchMethod)-[:USES_TECHNIQUE]->(dct:DataCollectionTechnique {id: $cid})
                DETACH DELETE rm
            `, { rid, cid });

            if (val.methods && val.methods.length > 0) {
                for (const method of val.methods) {
                    const resourcesStr = JSON.stringify(method.resources || []);
                    await session.run(`
                        MATCH (sub:ResearchDesignSubCategory {id: $rid})
                        MATCH (dct:DataCollectionTechnique {id: $cid})
                        
                        CREATE (rm:ResearchMethod {
                            id: $mid, name: $mname, suitability: $msuit, resources: $mres, matrixType: $type
                        })
                        MERGE (sub)-[:HAS_METHOD]->(rm)
                        MERGE (rm)-[:USES_TECHNIQUE]->(dct)
                        SET rm.cell_suitability = $csuit
                    `, {
                        rid, cid, type, mid: method.id, mname: method.name,
                        msuit: method.val, mres: resourcesStr, csuit: val.suitability || ""
                    });
                }
            } else {
                if (val.suitability) {
                    await session.run(`
                        MATCH (sub:ResearchDesignSubCategory {id: $rid})
                        MATCH (dct:DataCollectionTechnique {id: $cid})
                        MERGE (sub)-[r:APPLICABILITY]->(dct)
                        SET r.suitability = $suit
                    `, { rid, cid, suit: val.suitability });
                }
            }
        }

        const validRowIds = matrix.rows.map(r => r.id);
        const validColIds = matrix.cols.map(c => c.id);
        await session.run(`MATCH (r:ResearchDesignSubCategory) WHERE NOT r.id IN $validRowIds AND EXISTS((:ResearchDesignClass)-[:LINKED_TO]->(:ResearchDesigns)-[:HAS_CATEGORY]->(:ResearchDesignCategory)-[:HAS_SUB_CATEGORY]->(r)) DETACH DELETE r`, { validRowIds });
        await session.run(`MATCH (c:DataCollectionTechnique) WHERE NOT c.id IN $validColIds AND EXISTS((:ResearchDesignClass)-[:LINKED_TO]->(:DataCollectionsTechniques)-[:HAS_TECHNIQUE]->(c)) DETACH DELETE c`, { validColIds });

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Save error" });
    } finally { session.close(); }
});

// LOAD: Reconstructs the matrix from the graph
app.get('/quality/matrix', async (req, res) => {
    const type = req.query.type || 'qualitative';
    const session = driver.session();
    try {
        const rowsRes = await session.run(`
            MATCH (rc:ResearchClass {name: $type})-[:HAS_DESIGN_CLASS]->(rdc)-[:LINKED_TO]->(:ResearchDesigns)-[:HAS_CATEGORY]->(cat)-[:HAS_SUB_CATEGORY]->(sub)
            RETURN sub.id as id, sub.name as name, sub.risks as risks, 
                   rdc.name as level1, cat.name as level2, 
                   sub.definition as definition, cat.definition as catDefinition,
                   sub.order as order
            ORDER BY order
        `, { type });

        const colsRes = await session.run(`
            MATCH (rc:ResearchClass {name: $type})-[:HAS_DESIGN_CLASS]->(rdc)-[:LINKED_TO]->(:DataCollectionsTechniques)-[:HAS_TECHNIQUE]->(dct)
            RETURN DISTINCT dct.id as id, dct.name as name, dct.risks as risks, dct.order as order
            ORDER BY order
        `, { type });

        const rows = rowsRes.records.map(r => ({
            id: r.get('id'), name: r.get('name'), risks: r.get('risks'),
            level1: r.get('level1'), level2: r.get('level2'),
            definition: r.get('definition'), catDefinition: r.get('catDefinition'),
            order: r.get('order')
        }));

        const cols = colsRes.records.map(r => ({
            id: r.get('id'), name: r.get('name'), risks: r.get('risks'), order: r.get('order')
        }));

        const data = {};

        // 1. Fetch Research Methods
        const methodsRes = await session.run(`
            MATCH (sub:ResearchDesignSubCategory)-[:HAS_METHOD]->(rm:ResearchMethod)-[:USES_TECHNIQUE]->(dct:DataCollectionTechnique)
            WHERE sub.id IN $rowIds AND dct.id IN $colIds
            RETURN sub.id as rid, dct.id as cid, rm
        `, { rowIds: rows.map(r => r.id), colIds: cols.map(c => c.id) });

        methodsRes.records.forEach(rec => {
            const key = `${rec.get('rid')}_${rec.get('cid')}`;
            const rm = rec.get('rm').properties;
            if (!data[key]) data[key] = { methods: [], suitability: "" };
            if (!data[key].suitability && rm.cell_suitability) data[key].suitability = rm.cell_suitability;
            let resources = [];
            try { resources = JSON.parse(rm.resources); } catch(e) {}
            data[key].methods.push({ id: rm.id, name: rm.name, val: rm.suitability, resources: resources });
        });

        // 2. Fetch Direct Applicability
        const appRes = await session.run(`
            MATCH (sub:ResearchDesignSubCategory)-[r:APPLICABILITY]->(dct:DataCollectionTechnique)
            WHERE sub.id IN $rowIds AND dct.id IN $colIds
            RETURN sub.id as rid, dct.id as cid, r.suitability as suit
        `, { rowIds: rows.map(r => r.id), colIds: cols.map(c => c.id) });

        appRes.records.forEach(rec => {
            const key = `${rec.get('rid')}_${rec.get('cid')}`;
            if (!data[key]) data[key] = { methods: [], suitability: "" };
            data[key].suitability = rec.get('suit');
        });

        res.json({ rows, cols, data });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Load error" });
    } finally { session.close(); }
});

app.post('/doi', async (req, res) => {
    const { doi } = req.body;
    try {
        const r = await axios.get(`https://api.crossref.org/works/${doi}`);
        if (!r.data || !r.data.message) return res.status(400).json({ error: "Invalid DOI" });
        const msg = r.data.message;
        res.json({
            doi: msg.DOI,
            title: msg.title?.[0] || "Untitled",
            year: msg.published?.['date-parts']?.[0]?.[0] || "n.d.",
            author: msg.author?.length ? `${msg.author[0].family}, ${msg.author[0].given}` : "Unknown",
            journal: msg['container-title']?.[0] || "Unknown",
        });
    } catch (e) { res.status(400).json({ error: "DOI not found" }); }
});

app.listen(3001, () => console.log("API running on port 3001"));