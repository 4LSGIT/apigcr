// test/templating.test.js
const { expect } = require('chai');
const templating = require('../lib/templating');
const resolvePlaceholders = templating.resolvePlaceholders;

describe('resolvePlaceholders', () => {
  const testContext = {
    variables: {
      contactPhone: "+972-54-1234567",
      contactData: {
        first_name: "Robert",
        last_name: "Smith",
        address: { city: "Tel Aviv" }
      },
      retryCount: 2
    },
    this: {
      status: "success",
      message: "SMS sent"
    },
    env: {
      executionId: 12345,
      stepNumber: 7
    }
  };

  it('should resolve a simple placeholder', () => {
    const result = resolvePlaceholders("Hello {{contactData.first_name}}!", testContext);
    expect(result).to.equal("Hello Robert!");
  });

  it('should resolve multiple placeholders in an object', () => {
    const result = resolvePlaceholders({
      phone: "{{contactPhone}}",
      greeting: "Hi {{this.message}} at {{env.now}}",
      retry: "{{retryCount}}"
    }, testContext);
    
    expect(result).to.deep.equal({
      phone: "+972-54-1234567",
      greeting: `Hi SMS sent at ${new Date().toISOString().split('T')[0]}T00:00:00.000Z`, // Adjust for current date
      retry: 2
    });
  });

  it('should return the original string for missing placeholders', () => {
    const result = resolvePlaceholders("Missing {{does.not.exist}}", testContext);
    expect(result).to.equal("Missing ");
  });

  it('should handle arrays of strings', () => {
    const result = resolvePlaceholders(["Hello {{contactData.first_name}}!", "Your phone is {{contactPhone}}."], testContext);
    expect(result).to.deep.equal(["Hello Robert!", "Your phone is +972-54-1234567."]);
  });

  it('should return the input if it is a primitive type', () => {
    const result = resolvePlaceholders(42, testContext);
    expect(result).to.equal(42);
  });
});
