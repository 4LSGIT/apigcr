# YisraHook – Programmable Event Ingestion & Routing Engine

YisraHook is a flexible, code-driven platform for receiving, transforming, and forwarding events from multiple sources—primarily webhooks and email—through a unified processing pipeline.

---

## ⚙️ Overview

YisraHook acts as a universal event processor:

- Accepts incoming events (HTTP requests, emails)
- Normalizes them into a unified format
- Executes user-defined transformation logic in a sandboxed environment
- Routes processed output to external destinations
- Ensures reliability through queuing, retries, and logging

---

## 🌐 Input Sources

### 🔹 Webhooks

**Endpoint:**
/hooks/:id

Capabilities:
- Accepts any HTTP request method
- Identifies handler via :id
- Supports configurable authentication (API key, none, etc.)

---

### 🔹 Email Input

**Format:**
:id@yourdomain.com

Features:
- Ingested via IMAP or email provider integration
- Parsed into structured event format
- Routed through the same processing engine as webhooks

---

## 🧩 Unified Event Model

All inputs are normalized into a single structure:

{
  "body": {},
  "headers": {},
  "query": {},
  "meta": {
    "source": "http" | "email"
  }
}

This ensures all handlers operate on a consistent data shape.

---

## 🧠 Processing Engine

Each hook defines custom JavaScript logic executed in a sandboxed VM.

### 🔹 Filter Stage

return input.body.number > 2;

---

### 🔹 Transformation Stage

return {
  name: input.body.name,
  value: input.body.number * 2
};

---

### 🔹 Routing Hints (Optional)

May influence routing behavior within safe constraints.

---

## 📬 Email Processing

Raw Email → Parsing Layer → Unified Event → JS VM → Output

Use cases:
- Extracting structured data from unstructured text
- Parsing forwarded messages
- Regex-based extraction
- Converting emails into API-like events

---

## 🚀 Delivery Layer

Processed events are forwarded to external systems.

Constraints:
- Network access is controlled by the system (not user code)
- Delivery configuration is predefined or safely parameterized

Supported actions:
- HTTP GET / POST / etc.
- Custom headers injection
- Secure internal authentication handling

---

## 🔐 Security Model

Sandbox restrictions:
- No filesystem access
- No environment variables
- No direct network access
- Time and memory limits enforced

Secrets are injected only at delivery stage.

---

## 🔄 Reliability & Job System

- Queued execution
- Retry with exponential backoff
- Persistent logging
- Execution tracking

---

## 🧠 Summary

YisraHook unifies:
- Webhooks
- Email ingestion
- Sandbox JS execution
- Controlled delivery

---

## 💡 Core Idea

Logic is defined as code per handler, enabling flexible event pipelines.

---

## 🏁 One-line Definition

YisraHook turns incoming webhooks and emails into programmable, secure, and reliable event pipelines.
