/**
 * Partner Skill Analysis Module
 * Uses Bytez API with Qwen3-0.6B to analyze partner capabilities
 * against assigned Work Packages and Tasks.
 */

const Bytez = require('bytez.js');
const { db, getSetting } = require('./database');

// Bytez SDK configuration
const BYTEZ_API_KEY = process.env.BYTEZ_API_KEY || 'c83895ef7c4ccca7c35e864c70115b8d';
const sdk = new Bytez(BYTEZ_API_KEY);
const model = sdk.model('Qwen/Qwen3-0.6B');

// Analysis queue for sequential processing
const analysisQueue = [];
let isProcessing = false;

// Track which partners have active analysis jobs
const analyzingPartners = new Set();

/**
 * Check if a partner has active analysis jobs (queued or processing)
 */
function isPartnerAnalyzing(partnerId) {
  // Check if currently being processed
  if (analyzingPartners.has(partnerId)) return true;
  // Check if in queue
  return analysisQueue.some(job => job.partnerId === partnerId);
}

// Jinja-style prompt templates
const PROMPT_TEMPLATES = {
  wpAnalysis: `
You are an expert project evaluator analyzing a partner organization's capabilities.

PROJECT CONTEXT:
{{project_description}}

Based on the project description above, evaluate how well this partner fits the project needs.

PARTNER INFORMATION:
- Name: {{partner_name}}
- Type: {{partner_type}}
- Country: {{partner_country}}

WORK PACKAGE TO EVALUATE:
- Name: {{wp_name}}
- Description: {{wp_description}}

PARTNER'S SCRAPED WEBSITE CONTENT:
{{scraped_content}}

SCORING CRITERIA - BE STRICT AND OBJECTIVE:
- Score 0: Totally irrelevant (no connection whatsoever)
- Score 1: ~20% related (weak connection, minor relevance)
- Score 2: ~40% related (some connection but significant gaps)
- Score 3: ~60% related (moderate fit, workable but not ideal)
- Score 4: ~80% related (strong fit, minor gaps only)
- Score 5: 100% related (excellent fit, perfect match)

TASK:
Analyze how well this partner is suited for the work package based on their expertise, 
experience, and capabilities as evidenced by their website content.

Provide your analysis in this JSON format:
{
  "overall_score": <number 0-5>,
  "confidence": <number 0-1>,
  "skills_identified": ["skill1", "skill2", ...],
  "strengths": ["strength1", "strength2"],
  "gaps": ["gap1", "gap2"],
  "rationale": "detailed explanation of the score - justify why you gave this score based on the scoring criteria above",
  "recommendation": "specific recommendation for this assignment"
}

IMPORTANT: Be harsh and critical. Most partners should score 0-2 unless they clearly demonstrate relevant expertise. Do not inflate scores.
`,

  taskAnalysis: `
You are an expert task evaluator analyzing partner capabilities.

PROJECT CONTEXT:
{{project_description}}

PARTNER: {{partner_name}} ({{partner_type}})

TASK DETAILS:
- Task: {{task_name}}
- Work Package: {{wp_name}}
- Description: {{task_description}}

PARTNER CONTENT:
{{scraped_content}}

SCORING CRITERIA - BE STRICT AND OBJECTIVE:
- Score 0: Totally irrelevant (no connection whatsoever)
- Score 1: ~20% related (weak connection, minor relevance)
- Score 2: ~40% related (some connection but significant gaps)
- Score 3: ~60% related (moderate fit, workable but not ideal)
- Score 4: ~80% related (strong fit, minor gaps only)
- Score 5: 100% related (excellent fit, perfect match)

Based on the project context above, evaluate this partner's suitability for this specific task.

Respond in JSON:
{
  "suitability_score": <number 0-5>,
  "relevant_experience": ["exp1", "exp2"],
  "required_resources": ["resource1", "resource2"],
  "risk_factors": ["risk1"],
  "analysis": "detailed analysis - justify your score based on the strict criteria above"
}

IMPORTANT: Be harsh and critical. Give 0-2 unless clear relevant expertise is demonstrated. Do not inflate scores.
`,

  skillExtraction: `
Extract and categorize the technical and domain skills from this organization description.

PROJECT CONTEXT:
{{project_description}}

ORGANIZATION CONTENT:
{{content}}

RELEVANCE FILTER - BE STRICT:
Only list skills that are DIRECTLY relevant to the project context described above.
If a skill has no clear connection to the project needs, do NOT include it.
Be harsh - most skills should be filtered out unless clearly applicable.

Provide JSON output:
{
  "technical_skills": ["skill1", "skill2"],
  "domain_expertise": ["domain1", "domain2"],
  "research_areas": ["area1", "area2"],
  "tools_platforms": ["tool1", "tool2"],
  "skill_summary": "brief narrative summary focusing only on project-relevant capabilities"
}

IMPORTANT: Only include skills with clear relevance to the project. Empty arrays are acceptable if no relevant skills are found."
`
};

/**
 * Simple Jinja-like template renderer
 */
function renderTemplate(template, variables) {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(regex, value || 'Not specified');
  }
  return result;
}

/**
 * Queue an analysis job for sequential processing
 */
function queueAnalysis(job) {
  analysisQueue.push(job);
  processQueue();
}

/**
 * Process analysis queue one at a time
 */
async function processQueue() {
  if (isProcessing || analysisQueue.length === 0) return;
  
  isProcessing = true;
  let job = analysisQueue.shift();
  
  // Normalize job properties
  job = {
    type: job.type,
    partnerId: Number(job.partnerId),
    wpId: job.wpId ? Number(job.wpId) : null,
    taskId: job.taskId ? Number(job.taskId) : null,
    tenantId: Number(job.tenantId)
  };
  
  console.log('Processing job:', JSON.stringify(job));
  
  // Validate job
  if (!job.partnerId || !job.tenantId) {
    console.error('Invalid job - missing partnerId or tenantId');
    isProcessing = false;
    processQueue();
    return;
  }
  
  // Mark partner as analyzing
  analyzingPartners.add(job.partnerId);
  
  try {
    await performAnalysis(job);
  } catch (error) {
    console.error('Analysis job failed:', error.message);
    // Save error status
    try {
      saveAnalysisError(job, error.message);
    } catch (saveError) {
      console.error('Failed to save error:', saveError.message);
    }
  } finally {
    // Remove from analyzing set
    analyzingPartners.delete(job.partnerId);
  }
  
  isProcessing = false;
  
  // Add delay between requests to respect rate limits
  // Wait 3 seconds before processing next job
  if (analysisQueue.length > 0) {
    console.log('Waiting 3s before next request...');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  processQueue(); // Process next
}

/**
 * Perform the actual AI analysis
 */
async function performAnalysis(job) {
  console.log('performAnalysis started');
  const { type, partnerId, wpId, taskId, tenantId } = job;
  
  console.log('Fetching partner data...');
  // Get partner data
  const partner = db.prepare('SELECT * FROM partners WHERE id = ? AND tenant_id = ?').get(partnerId, tenantId);
  if (!partner) throw new Error('Partner not found');
  console.log('Partner found:', partner.name);
  
  console.log('Fetching scraped content...');
  // Get ALL scraped content for this partner
  const scrapedRows = db.prepare(
    'SELECT content, url_id, url FROM scraped_content WHERE partner_id = ? AND tenant_id = ? AND status = ? ORDER BY scraped_at DESC'
  ).all(partnerId, tenantId, 'completed');
  
  if (!scrapedRows || scrapedRows.length === 0) {
    throw new Error('No scraped content available for analysis');
  }
  
  // Combine all URLs but limit total size to ~4000 chars to keep prompt reasonable
  let combinedContent = '';
  for (const row of scrapedRows) {
    const urlHeader = `--- ${row.url} ---\n`;
    if (combinedContent.length + urlHeader.length + row.content.length > 4000) {
      // Add truncated note if we're hitting the limit
      if (combinedContent.length < 3800) {
        combinedContent += urlHeader + row.content.substring(0, 4000 - combinedContent.length - urlHeader.length - 50) + '... [truncated]\n\n';
      }
      break;
    }
    combinedContent += urlHeader + row.content + '\n\n';
  }
  
  const scrapedData = {
    content: combinedContent.trim(),
    url_id: scrapedRows[0].url_id
  };
  
  console.log(`Scraped content: ${scrapedRows.length} URLs, combined length: ${scrapedData.content.length}`);
  
  let prompt;
  let analysisType;
  
  if (type === 'wp' && wpId) {
    // Work Package analysis
    const wp = db.prepare('SELECT * FROM wps WHERE id = ? AND tenant_id = ?').get(wpId, tenantId);
    if (!wp) throw new Error('Work Package not found');
    
    // Get project description for context
    const projectDescription = getSetting('project_description', 'No project description provided.');
    
    prompt = renderTemplate(PROMPT_TEMPLATES.wpAnalysis, {
      partner_name: partner.name,
      partner_type: partner.type,
      partner_country: partner.country,
      wp_name: wp.name,
      wp_description: wp.name, // Using name as description if no separate field
      scraped_content: scrapedData.content.substring(0, 4000),
      project_description: projectDescription
    });
    analysisType = 'work_package';
    
  } else if (type === 'task' && taskId) {
    // Task analysis
    const task = db.prepare('SELECT t.*, w.name as wp_name FROM tasks t JOIN wps w ON t.wp_id = w.id WHERE t.id = ?').get(taskId);
    if (!task) throw new Error('Task not found');
    
    // Get project description for context
    const projectDescription = getSetting('project_description', 'No project description provided.');
    
    prompt = renderTemplate(PROMPT_TEMPLATES.taskAnalysis, {
      partner_name: partner.name,
      partner_type: partner.type,
      task_name: task.name,
      wp_name: task.wp_name,
      task_description: task.name,
      scraped_content: scrapedData.content.substring(0, 3000),
      project_description: projectDescription
    });
    analysisType = 'task';
    
  } else if (type === 'skills') {
    // Get project description for context
    const projectDescription = getSetting('project_description', 'No project description provided.');
    
    // General skill extraction
    prompt = renderTemplate(PROMPT_TEMPLATES.skillExtraction, {
      content: scrapedData.content.substring(0, 4000),
      project_description: projectDescription
    });
    analysisType = 'skill_extraction';
    
  } else {
    throw new Error('Invalid analysis type');
  }
  
  // Call Bytez API
  console.log(`Analyzing ${type} for partner ${partnerId}...`);
  console.log('Prompt length:', prompt.length);
  
  let error, output;
  try {
    const result = await model.run([
      { role: 'user', content: prompt }
    ]);
    error = result.error;
    // Bytez returns an object with role and content, extract the content
    output = typeof result.output === 'object' ? result.output?.content : result.output;
  } catch (apiError) {
    console.error('Bytez API error:', apiError.message);
    throw new Error(`Bytez API error: ${apiError.message}`);
  }
  
  if (error) {
    throw new Error(`AI API error: ${error}`);
  }
  console.log('Bytez API response received, output type:', typeof output, 'length:', output?.length || 0);
  
  // Parse JSON from response
  const analysisText = output || '';
  let analysisData;
  
  try {
    // Try to extract JSON from response
    const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      analysisData = JSON.parse(jsonMatch[0]);
    } else {
      analysisData = { raw_analysis: analysisText };
    }
  } catch (e) {
    analysisData = { raw_analysis: analysisText, parse_error: e.message };
  }
  
  // Save to database
  const saveData = {
    partnerId,
    wpId,
    taskId,
    analysisType,
    content: analysisText,
    skills: JSON.stringify(analysisData),
    confidence: analysisData.confidence || analysisData.suitability_score || 0.5,
    model: 'Qwen/Qwen3-0.6B',
    tenantId
  };
  
  console.log('About to save:', Object.keys(saveData));
  console.log('content is:', typeof saveData.content, JSON.stringify(saveData.content));
  
  saveAnalysis(saveData);
  
  // Also update partner_wp_skills for work_package analyses (so dashboard shows the scores)
  if (analysisType === 'work_package' && wpId && analysisData.overall_score !== undefined) {
    try {
      const rationale = analysisData.rationale || analysisData.recommendation || '';
      db.prepare(`
        INSERT INTO partner_wp_skills (partner_id, wp_id, score, rationale, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(partner_id, wp_id) DO UPDATE SET
          score = excluded.score,
          rationale = excluded.rationale,
          updated_at = excluded.updated_at
      `).run(partnerId, wpId, analysisData.overall_score, rationale.substring(0, 500));
      console.log(`Updated partner_wp_skills: partner=${partnerId}, wp=${wpId}, score=${analysisData.overall_score}`);
    } catch (e) {
      console.error('Failed to update partner_wp_skills:', e.message);
    }
  }
  
  console.log(`Analysis complete for partner ${partnerId}`);
  return analysisData;
}

/**
 * Save analysis results to database
 */
function saveAnalysis(data) {
  console.log('saveAnalysis called for partner:', data.partnerId);
  console.log('Data:', JSON.stringify({
    partnerId: data.partnerId,
    wpId: data.wpId,
    taskId: data.taskId,
    urlId: data.urlId,
    analysisType: data.analysisType,
    contentLength: data.content?.length,
    skillsLength: data.skills?.length,
    confidence: data.confidence,
    model: data.model,
    tenantId: data.tenantId
  }));
  
  try {
    const stmt = db.prepare(`
      INSERT INTO partner_ai_analysis 
      (partner_id, wp_id, task_id, url_id, analysis_type, content, skills, confidence_score, model_used, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const params = [
      data.partnerId,
      data.wpId || null,
      data.taskId || null,
      data.urlId || null,
      data.analysisType,
      data.content,
      data.skills,
      data.confidence,
      data.model,
      data.tenantId
    ];
    
    console.log('Executing with params:', params.length, 'values');
    stmt.run(...params);
    console.log('saveAnalysis completed successfully');
  } catch (e) {
    console.error('saveAnalysis error:', e.message);
    throw e;
  }
}

/**
 * Save analysis error to database
 */
function saveAnalysisError(job, errorMessage) {
  try {
    console.log('saveAnalysisError called for partner:', job.partnerId);
    
    const stmt = db.prepare(`
      INSERT INTO partner_ai_analysis 
      (partner_id, wp_id, task_id, analysis_type, content, skills, tenant_id)
      VALUES (?, ?, ?, 'error', ?, ?, ?)
    `);
    stmt.run(
      job.partnerId,
      job.wpId || null,
      job.taskId || null,
      `Error: ${errorMessage}`,
      JSON.stringify({ error: errorMessage }),
      job.tenantId
    );
  } catch (e) {
    console.error('Failed to save error:', e);
  }
}

/**
 * Analyze all assigned WPs and tasks for a partner
 * Uses queue system for sequential processing with delays
 */
function analyzePartner(partnerId, tenantId) {
  console.log('analyzePartner called:', partnerId, tenantId);
  
  // Clear old analysis for this partner before running new analysis
  console.log('Clearing old analysis data...');
  db.prepare('DELETE FROM partner_ai_analysis WHERE partner_id = ?').run(partnerId);
  console.log('Old analysis cleared');
  
  // Get ALL WPs in the tenant (not just assigned ones)
  console.log('Querying all WPs...');
  const allWPs = db.prepare(`SELECT id, name FROM wps WHERE tenant_id = ? ORDER BY id`).all(tenantId);
  console.log('Found WPs:', allWPs.length);

  // Get ALL tasks in the tenant (not just assigned ones)
  console.log('Querying all tasks...');
  const allTasks = db.prepare(`SELECT t.id, t.name, t.wp_id FROM tasks t JOIN wps w ON t.wp_id = w.id WHERE w.tenant_id = ? ORDER BY t.id`).all(tenantId);
  console.log('Found tasks:', allTasks.length);

  // Queue skill extraction first
  queueAnalysis({
    type: 'skills',
    partnerId,
    tenantId
  });

  // Queue WP analyses for every WP in the project
  for (const wp of allWPs) {
    queueAnalysis({
      type: 'wp',
      partnerId,
      wpId: wp.id,
      tenantId
    });
  }

  // Queue task analyses for every task in the project
  for (const task of allTasks) {
    queueAnalysis({
      type: 'task',
      partnerId,
      taskId: task.id,
      tenantId
    });
  }

  return {
    queued: 1 + allWPs.length + allTasks.length,
    workPackages: allWPs.length,
    tasks: allTasks.length
  };
}

/**
 * Analyze a single Work Package with a specific URL's content
 */
async function analyzeWorkPackage(partnerId, tenantId, wp, urlData) {
  const partner = db.prepare('SELECT * FROM partners WHERE id = ? AND tenant_id = ?').get(partnerId, tenantId);
  if (!partner) throw new Error('Partner not found');
  
  const projectDescription = getSetting('project_description', 'No project description provided.');
  
  const prompt = renderTemplate(PROMPT_TEMPLATES.wpAnalysis, {
    partner_name: partner.name,
    partner_type: partner.type,
    partner_country: partner.country,
    wp_name: wp.name,
    wp_description: wp.name,
    scraped_content: urlData.content.substring(0, 4000),
    project_description: projectDescription
  });
  
  console.log(`Calling Bytez API for WP ${wp.id}...`);
  const result = await model.run([{ role: 'user', content: prompt }]);
  
  if (result.error) {
    throw new Error(`AI API error: ${result.error}`);
  }
  
  const output = typeof result.output === 'object' ? result.output?.content : result.output;
  
  // Parse JSON response
  let analysisData;
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      analysisData = JSON.parse(jsonMatch[0]);
    } else {
      analysisData = { raw_analysis: output };
    }
  } catch (e) {
    analysisData = { raw_analysis: output, parse_error: e.message };
  }
  
  // Save to database
  saveAnalysis({
    partnerId,
    wpId: wp.id,
    taskId: null,
    urlId: urlData.id,
    analysisType: 'work_package',
    content: output,
    skills: JSON.stringify(analysisData),
    confidence: analysisData.confidence || 0.5,
    model: 'Qwen/Qwen3-0.6B',
    tenantId
  });
  
  return analysisData;
}

/**
 * Extract skills from a single URL
 */
async function analyzeSkills(partnerId, tenantId, urlData) {
  const projectDescription = getSetting('project_description', 'No project description provided.');
  
  const prompt = renderTemplate(PROMPT_TEMPLATES.skillExtraction, {
    content: urlData.content.substring(0, 4000),
    project_description: projectDescription
  });
  
  console.log('Calling Bytez API for skill extraction...');
  const result = await model.run([{ role: 'user', content: prompt }]);
  
  if (result.error) {
    throw new Error(`AI API error: ${result.error}`);
  }
  
  const output = typeof result.output === 'object' ? result.output?.content : result.output;
  
  // Parse JSON response
  let analysisData;
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      analysisData = JSON.parse(jsonMatch[0]);
    } else {
      analysisData = { raw_analysis: output };
    }
  } catch (e) {
    analysisData = { raw_analysis: output, parse_error: e.message };
  }
  
  // Save to database
  saveAnalysis({
    partnerId,
    wpId: null,
    taskId: null,
    urlId: urlData.id,
    analysisType: 'skill_extraction',
    content: output,
    skills: JSON.stringify(analysisData),
    confidence: 0.5,
    model: 'Qwen/Qwen3-0.6B',
    tenantId
  });
  
  return analysisData;
}

/**
 * Get analysis results for a partner
 */
function getPartnerAnalysis(partnerId, tenantId) {
  const analyses = db.prepare(
    'SELECT * FROM partner_ai_analysis WHERE partner_id = ? AND tenant_id = ? ORDER BY analyzed_at DESC'
  ).all(partnerId, tenantId);
  
  return analyses.map(a => ({
    ...a,
    skills: a.skills ? JSON.parse(a.skills) : null
  }));
}

module.exports = {
  queueAnalysis,
  analyzePartner,
  getPartnerAnalysis,
  isPartnerAnalyzing,
  renderTemplate,
  PROMPT_TEMPLATES
};
