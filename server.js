const express = require('express');
const cors = require('cors');
const axios = require('axios');
const neo4j = require('neo4j-driver');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for large imports

// --- NEO4J CONNECTION ---
//const driver = neo4j.driver(
//    'neo4j://localhost:7687',
//    neo4j.auth.basic('neo4j', 'neo4j')
//);

// --- NEO4J CONNECTION ---
const driver = neo4j.driver(
    "neo4j+s://c44a5701.databases.neo4j.io",
    neo4j.auth.basic("neo4j", "GhApEmnnOL6ZEm0hjas143NH8IifKpNMVSp8SsG4PDY")
);

const verifyConnection = async () => {
    try {
        await driver.verifyConnectivity();
        console.log('✅ Connected to Neo4j');
    } catch (error) {
        console.error('❌ Neo4j Connection Failed:', error.message);
    }
};
verifyConnection();

// --- MAP MANAGEMENT ---

// GET MAPS
app.get('/maps', async (req, res) => {
    const session = driver.session();
    try {
        await session.run(`MERGE (:RootNode {name: "Maps"})`);
        const result = await session.run(`
            MATCH (:RootNode {name: "Maps"})-[:HAS_MAP]->(m:Map) 
            RETURN m.name ORDER BY m.name
        `);
        const maps = result.records.map(r => r.get('m.name'));
        res.json(maps);
    } catch (err) {
        console.error("Fetch maps error:", err);
        res.status(500).json({ error: "Neo4j error" });
    } finally { session.close(); }
});

// CREATE MAP
app.post('/maps', async (req, res) => {
    const { name, password } = req.body;
    const session = driver.session();
    try {
        await session.run(`
            MERGE (root:RootNode {name: "Maps"})
            MERGE (m:Map {name: $name})
            MERGE (root)-[:HAS_MAP]->(m)
            ON CREATE SET m.password = $password
        `, { name, password });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Creation error" }); } finally { session.close(); }
});

// DELETE MAP
app.delete('/maps', async (req, res) => {
    const { name, password } = req.body;
    const session = driver.session();
    try {
        const result = await session.run(`MATCH (m:Map {name: $name}) RETURN m.password as pwd`, { name });
        if (result.records.length === 0) return res.status(404).json({ error: "Map not found" });

        const storedPassword = result.records[0].get('pwd');
        if (storedPassword && storedPassword !== password) return res.status(403).json({ error: "Incorrect password" });

        await session.run(`MATCH (n:Factor {mapName: $name}) DETACH DELETE n`, { name });
        await session.run(`MATCH (m:Map {name: $name}) DETACH DELETE m`, { name });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Delete error" }); } finally { session.close(); }
});

// --- IMPORT / EXPORT ---

// EXPORT MAP
app.post('/map/export', async (req, res) => {
    const { mapName, password } = req.body;
    const session = driver.session();
    try {
        const authRes = await session.run(`MATCH (m:Map {name: $mapName}) RETURN m.password as pwd`, { mapName });
        if (authRes.records.length === 0) return res.status(404).json({ error: "Map not found" });

        const storedPwd = authRes.records[0].get('pwd');
        if (storedPwd && storedPwd !== password) return res.status(403).json({ error: "Incorrect password" });

        const result = await session.run(`
            MATCH (m:Map {name: $mapName})
            OPTIONAL MATCH (n:Factor {mapName: $mapName})
            OPTIONAL MATCH (n)-[r:EVIDENCE]->(t:Factor {mapName: $mapName})
            RETURN 
                { name: m.name, password: m.password } as mapData,
                collect(DISTINCT properties(n)) as nodes,
                collect(DISTINCT { source: n.name, target: t.name, props: properties(r) }) as edges
        `, { mapName });

        const rec = result.records[0];
        const exportData = {
            map: rec.get('mapData'),
            nodes: rec.get('nodes'),
            edges: rec.get('edges').filter(e => e.target !== null)
        };
        res.json(exportData);
    } catch (err) { res.status(500).json({ error: "Export error" }); } finally { session.close(); }
});

// IMPORT MAP
app.post('/map/import', async (req, res) => {
    const { map, mapData, nodes = [], edges = [] } = req.body;
    const mapInfo = mapData || map;

    if (!mapInfo) {
        return res.status(400).json({ error: "Invalid import format: no map or mapData found" });
    }

    const mapName = mapInfo.name;
    const password = mapInfo.password || "";
    const session = driver.session();

    try {
        const check = await session.run(`MATCH (m:Map {name: $mapName}) RETURN m`, { mapName });
        if (check.records.length > 0) return res.status(409).json({ error: "Map exists" });

        await session.executeWrite(async tx => {
            await tx.run(`
                MERGE (root:RootNode {name: "Maps"})
                CREATE (m:Map {name: $mapName, password: $password})
                MERGE (root)-[:HAS_MAP]->(m)
            `, { mapName, password });

            if (nodes.length > 0) {
                await tx.run(`
                    UNWIND $batch as row
                    CREATE (n:Factor)
                    SET n = row, n.mapName = $mapName
                    WITH n
                    MATCH (m:Map {name: $mapName})
                    MERGE (n)-[:BELONGS_TO]->(m)
                `, { batch: nodes, mapName });
            }

            if (edges.length > 0) {
                await tx.run(`
                    UNWIND $batch as row
                    MATCH (s:Factor {name: row.source, mapName: $mapName})
                    MATCH (t:Factor {name: row.target, mapName: $mapName})
                    CREATE (s)-[r:EVIDENCE]->(t)
                    SET r = row.props
                `, { batch: edges, mapName });
            }
        });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Import error" });
    } finally {
        session.close();
    }
});

// --- GRAPH OPERATIONS ---

app.post('/graph', async (req, res) => {
    const { mapName, password } = req.body;
    const session = driver.session();
    try {
        const authRes = await session.run(`MATCH (m:Map {name: $mapName}) RETURN m.password as pwd`, { mapName });
        if (authRes.records.length === 0) return res.status(404).json({ error: "Map not found" });
        if (authRes.records[0].get('pwd') !== password) return res.status(403).json({ error: "Incorrect password" });

        const result = await session.run(`
            MATCH (n:Factor {mapName: $mapName})
            OPTIONAL MATCH (n)-[r:EVIDENCE]->(t:Factor {mapName: $mapName})
            RETURN n, r, t
        `, { mapName });

        const elements = [];
        const nodes = new Set();
        result.records.forEach(r => {
            const n = r.get('n'); const rel = r.get('r'); const t = r.get('t');
            if (!nodes.has(n.properties.name)) {
                nodes.add(n.properties.name);
                elements.push({ data: { id: n.properties.name, label: n.properties.name, definition: n.properties.definition || "" } });
            }
            if (rel && t) {
                if (!nodes.has(t.properties.name)) {
                    nodes.add(t.properties.name);
                    elements.push({ data: { id: t.properties.name, label: t.properties.name, definition: t.properties.definition || "" } });
                }
                elements.push({
                    group: 'edges',
                    data: { source: n.properties.name, target: t.properties.name, label: rel.properties.author, ...rel.properties }
                });
            }
        });
        res.json({ elements });
    } catch (err) { res.status(500).json({ error: "Graph error" }); } finally { session.close(); }
});

app.post('/save-relationship', async (req, res) => {
    const { source, target, metadata, level, causality, mapName } = req.body;
    const session = driver.session();
    try {
        await session.run(`
            MATCH (m:Map {name: $mapName})
            MERGE (s:Factor {name: $source, mapName: $mapName}) MERGE (s)-[:BELONGS_TO]->(m)
            MERGE (t:Factor {name: $target, mapName: $mapName}) MERGE (t)-[:BELONGS_TO]->(m)
            MERGE (s)-[r:EVIDENCE {doi: $metadata.doi}]->(t)
            SET r += { title: $metadata.title, author: $metadata.author, year: $metadata.year, journal: $metadata.journal, level: $level, causality: $causality, notes: "" }
        `, { source, target, metadata, level, causality: causality || "", mapName });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Save error" }); } finally { session.close(); }
});

app.post('/relationship/update', async (req, res) => {
    const { source, target, doi, level, causality, notes, mapName } = req.body;
    const session = driver.session();
    try {
        await session.run(`
            MATCH (s:Factor {name: $source, mapName: $mapName})-[r:EVIDENCE {doi: $doi}]->(t:Factor {name: $target, mapName: $mapName})
            SET r.level = $level, r.causality = $causality, r.notes = $notes
        `, { source, target, doi, level, causality, notes, mapName });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Update error" }); } finally { session.close(); }
});

app.post('/node/rename', async (req, res) => {
    const { oldName, newName, mapName } = req.body;
    const session = driver.session();
    try {
        await session.run(`MATCH (n:Factor {name: $oldName, mapName: $mapName}) SET n.name = $newName`, { oldName, newName, mapName });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Rename error" }); } finally { session.close(); }
});

app.post('/node/definition', async (req, res) => {
    const { name, definition, mapName } = req.body;
    const session = driver.session();
    try {
        await session.run(`MATCH (n:Factor {name: $name, mapName: $mapName}) SET n.definition = $definition`, { name, definition, mapName });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Def error" }); } finally { session.close(); }
});

app.delete('/relationship', async (req, res) => {
    const { source, target, doi, mapName } = req.body;
    const session = driver.session();
    try {
        await session.run(`MATCH (s:Factor {name: $source, mapName: $mapName})-[r:EVIDENCE {doi: $doi}]->(t:Factor {name: $target, mapName: $mapName}) DELETE r`, { source, target, doi, mapName });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Delete error" }); } finally { session.close(); }
});

app.delete('/node', async (req, res) => {
    const { name, mapName } = req.body;
    const session = driver.session();
    try {
        await session.run(`MATCH (n:Factor {name: $name, mapName: $mapName}) DETACH DELETE n`, { name, mapName });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Delete error" }); } finally { session.close(); }
});

// --- RESOURCES MATRIX & RESOURCE NODES ---

// 1. ADD NEW METHOD TO CELL
app.post('/method/create', async (req, res) => {
    const { id, name, designId, techniqueId } = req.body;
    const session = driver.session();
    try {
        await session.run(`
            MATCH (d:ResearchDesignCategory {id: $designId})
            MATCH (t:DataCollectionTechnique {id: $techniqueId})
            MERGE (rm:ResearchMethod {id: $id})
            SET rm.name = $name
            
            // Link: [ResearchDesignCategory] -> [ResearchMethod]
            MERGE (d)-[:HAS_METHOD]->(rm)
            
            // Link: [DataCollectionTechnique] -> [ResearchMethod]
            MERGE (t)-[:CONTRIBUTES_TO]->(rm)
        `, { id, name, designId, techniqueId });
        res.json({ success: true });
    } catch (err) {
        console.error("Method create error:", err);
        res.status(500).json({ error: "Creation error" });
    } finally {
        session.close();
    }
});

// 2. RESOURCE MANAGEMENT

// Fetch Resources for a Method with Filters
app.post('/method/:id/resources', async (req, res) => {
    const { id } = req.params;
    const { types, tags } = req.body; // types: array, tags: array
    const session = driver.session();
    try {
        let query = `
            MATCH (rm:ResearchMethod {id: $id})-[:HAS_RESOURCE]->(r:Resource)
            WHERE r.type IN $types
        `;

        if (tags && tags.length > 0) {
            // Updated Clause: Check if resource tags are empty OR if they match
            // This allows untagged resources (newly added) to show up even if filters are active.
            query += ` AND (size(r.tags) = 0 OR r.tags IS NULL OR any(tag IN r.tags WHERE tag IN $tags))`;
        }

        query += ` RETURN properties(r) as resource ORDER BY r.year DESC`;

        const result = await session.run(query, { id, types, tags: tags || [] });
        const resources = result.records.map(rec => rec.get('resource'));
        res.json(resources);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Fetch error" });
    } finally {
        session.close();
    }
});

// Add General Resource (Paper/Guideline)
app.post('/resource/add', async (req, res) => {
    const { methodId, methodName, type, metadata, tags } = req.body;
    const session = driver.session();
    try {
        const resourceId = `res-${Date.now()}`;
        // CHANGED: Use MERGE and set name to ensure node exists
        await session.run(`
            MERGE (rm:ResearchMethod {id: $methodId})
            ON CREATE SET rm.name = $methodName
            CREATE (r:Resource {
                id: $resourceId,
                type: $type,
                doi: $metadata.doi,
                title: $metadata.title,
                author: $metadata.author,
                year: $metadata.year,
                journal: $metadata.journal,
                abstract: $metadata.abstract,
                tags: $tags
            })
            MERGE (rm)-[:HAS_RESOURCE]->(r)
        `, { methodId, methodName, type, resourceId, metadata: { ...metadata, abstract: metadata.abstract || "No abstract." }, tags: tags || [] });
        res.json({ success: true, id: resourceId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Add error" });
    } finally {
        session.close();
    }
});

// Add Empirical Standard
app.post('/resource/add-standard', async (req, res) => {
    const { methodId, methodName, title, attributes, type } = req.body;
    const session = driver.session();
    try {
        const resourceId = `std-${Date.now()}`;
        // CHANGED: Use MERGE and set name here too
        await session.run(`
            MERGE (rm:ResearchMethod {id: $methodId})
            ON CREATE SET rm.name = $methodName
            CREATE (r:Resource {
                id: $resourceId,
                type: $type,
                title: $title,
                author: "Empirical Standard",
                year: toString(date().year),
                attributes: $attributes,
                tags: []
            })
            MERGE (rm)-[:HAS_RESOURCE]->(r)
        `, { methodId, methodName, title, type, resourceId, attributes }); // attributes stored as list of maps
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Add Standard error" });
    } finally {
        session.close();
    }
});

// Tag Resource
app.post('/resource/tag', async (req, res) => {
    const { resourceId, tag, action } = req.body;
    const session = driver.session();
    try {
        if (action === 'add') {
            await session.run(`
                MATCH (r:Resource {id: $resourceId})
                WHERE NOT $tag IN r.tags
                SET r.tags = r.tags + $tag
            `, { resourceId, tag });
        } else {
            await session.run(`
                MATCH (r:Resource {id: $resourceId})
                SET r.tags = [x IN r.tags WHERE x <> $tag]
            `, { resourceId, tag });
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Tag error" });
    } finally {
        session.close();
    }
});


// 3. SAVE MATRIX
app.post('/quality/matrix/save', async (req, res) => {
    const { type, matrix } = req.body;
    const session = driver.session();
    try {
        // Save Paradigm (Research Class)
        await session.run(`MERGE (rc:ResearchClass {name: $type})`, { type });

        // Save Data Collection Techniques (Columns)
        if (matrix.cols && matrix.cols.length > 0) {
            await session.run(`
                UNWIND $cols AS col
                MERGE (t:DataCollectionTechnique {id: col.id})
                SET t.name = col.name, t.risks = col.risks
            `, { cols: matrix.cols });
        }

        // Save Research Designs (Rows) with Hierarchy
        if (matrix.rows && matrix.rows.length > 0) {
            await session.run(`
                UNWIND $rows AS row
                MERGE (rc:ResearchClass {name: $type})
                
                MERGE (rsc:ResearchSubclass {name: row.level1})
                MERGE (rc)-[:HAS_SUBCLASS]->(rsc)
                
                MERGE (d:ResearchDesignCategory {id: row.id})
                SET d.name = row.name, 
                    d.level1 = row.level1, 
                    d.level2 = row.level2, 
                    d.definition = row.definition,
                    d.catDefinition = row.catDefinition,
                    d.risks = row.risks
                
                MERGE (rsc)-[:HAS_CATEGORY]->(d)
            `, { rows: matrix.rows, type });

            // Link active Subclasses to all current Data Collection Techniques
            if (matrix.cols && matrix.cols.length > 0) {
                await session.run(`
                    UNWIND $rows AS row
                    MATCH (rsc:ResearchSubclass {name: row.level1})
                    WITH rsc
                    UNWIND $cols as col
                    MATCH (t:DataCollectionTechnique {id: col.id})
                    MERGE (rsc)-[:HAS_TECHNIQUE]->(t)
                 `, { rows: matrix.rows, cols: matrix.cols });
            }
        }

        // Save Research Methods (Nodes only, Resources are now separate nodes)
        const methodsToSave = [];
        const cellSuitabilities = [];

        Object.keys(matrix.data).forEach(key => {
            const [rowId, colId] = key.split('_');
            const cell = matrix.data[key];

            if (cell.methods && cell.methods.length > 0) {
                cell.methods.forEach(m => {
                    methodsToSave.push({
                        id: m.id,
                        name: m.name,
                        rowId: rowId,
                        colId: colId
                        // We do NOT overwrite resources here anymore
                    });
                });
            }

            if (cell.suitability) {
                cellSuitabilities.push({ rowId, colId, val: cell.suitability });
            }
        });

        if (methodsToSave.length > 0) {
            await session.run(`
                UNWIND $methods AS m
                MERGE (rm:ResearchMethod {id: m.id})
                SET rm.name = m.name
                
                WITH rm, m
                MATCH (d:ResearchDesignCategory {id: m.rowId})
                MATCH (t:DataCollectionTechnique {id: m.colId})
                
                MERGE (d)-[:HAS_METHOD]->(rm)
                MERGE (t)-[:CONTRIBUTES_TO]->(rm)
            `, { methods: methodsToSave });
        }

        if (cellSuitabilities.length > 0) {
            await session.run(`
                UNWIND $cells AS c
                MATCH (d:ResearchDesignCategory {id: c.rowId})
                MATCH (t:DataCollectionTechnique {id: c.colId})
                MERGE (d)-[r:COMPATIBLE_WITH]->(t)
                SET r.suitability = c.val
            `, { cells: cellSuitabilities });
        }

        res.json({ success: true });
    } catch (err) {
        console.error("Matrix save error:", err);
        res.status(500).json({ error: "Save error" });
    } finally {
        session.close();
    }
});

// 4. GET MATRIX (Updated to not fetch resources as JSON string)
app.get('/quality/matrix', async (req, res) => {
    const { type } = req.query;
    const session = driver.session();
    try {
        const result = await session.run(`
            MATCH (rc:ResearchClass {name: $type})
            OPTIONAL MATCH (rc)-[:HAS_SUBCLASS]->(rsc:ResearchSubclass)-[:HAS_CATEGORY]->(d:ResearchDesignCategory)
            OPTIONAL MATCH (rsc)-[:HAS_TECHNIQUE]->(t:DataCollectionTechnique)
            OPTIONAL MATCH (d)-[:HAS_METHOD]->(rm:ResearchMethod)<-[:CONTRIBUTES_TO]-(t)
            OPTIONAL MATCH (d)-[r:COMPATIBLE_WITH]->(t)

            RETURN 
                collect(DISTINCT d) as rows, 
                collect(DISTINCT t) as cols, 
                collect(DISTINCT {method: rm, rowId: d.id, colId: t.id}) as methods,
                collect(DISTINCT {rowId: d.id, colId: t.id, suitability: r.suitability}) as suitabilities
        `, { type });

        if (result.records.length === 0) {
            return res.json({ rows: [], cols: [], data: {} });
        }

        const rec = result.records[0];
        const neoRows = rec.get('rows').map(r => r.properties);
        const neoCols = rec.get('cols').map(r => r.properties);
        const neoMethods = rec.get('methods');
        const neoSuitabilities = rec.get('suitabilities');

        const data = {};

        neoSuitabilities.forEach(item => {
            if (item.rowId && item.colId && item.suitability) {
                const key = `${item.rowId}_${item.colId}`;
                if (!data[key]) data[key] = { methods: [], suitability: "" };
                data[key].suitability = item.suitability;
            }
        });

        neoMethods.forEach(item => {
            const m = item.method;
            if (m && item.rowId && item.colId) {
                const key = `${item.rowId}_${item.colId}`;
                if (!data[key]) data[key] = { methods: [], suitability: "" };

                // Resources are now fetched on demand in the detailed view
                data[key].methods.push({
                    id: m.properties.id,
                    name: m.properties.name,
                    resources: []
                });
            }
        });

        res.json({
            rows: neoRows,
            cols: neoCols,
            data: data
        });

    } catch (err) {
        console.error("Matrix load error:", err);
        res.status(500).json({ error: "Load error" });
    } finally {
        session.close();
    }
});

app.post('/doi', async (req, res) => {
    const { doi } = req.body;
    try {
        const r = await axios.get(`https://api.crossref.org/works/${doi}`);
        const msg = r.data.message;
        res.json({
            doi: msg.DOI,
            title: msg.title?.[0] || "Untitled",
            year: msg.published?.['date-parts']?.[0]?.[0] || "n.d.",
            author: msg.author?.length ? `${msg.author[0].family}, ${msg.author[0].given}` : "Unknown",
            journal: msg['container-title']?.[0] || "Unknown",
            abstract: "Abstract fetching requires specific API permissions.", // Placeholder
        });
    } catch (e) { res.status(400).json({ error: "DOI not found" }); }
});

// NEW: ISBN Endpoint
app.post('/isbn', async (req, res) => {
    const { isbn } = req.body;
    try {
        // Using Google Books API for ISBN lookup
        const r = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
        if (!r.data.items || r.data.items.length === 0) return res.status(404).json({ error: "ISBN not found" });

        const info = r.data.items[0].volumeInfo;
        res.json({
            doi: isbn, // Using ISBN as the identifier since DOI is N/A
            title: info.title,
            year: info.publishedDate ? info.publishedDate.substring(0, 4) : "n.d.",
            author: info.authors ? info.authors.join(', ') : "Unknown",
            journal: info.publisher || "Unknown Publisher",
            abstract: info.description || "No description available."
        });
    } catch (e) {
        console.error(e);
        res.status(400).json({ error: "Error fetching ISBN" });
    }
});

app.listen(3001, () => console.log("API running on port 3001"));