const functions = {
  refreshAppOAuthToken: async (params) => {
    // Mock: replace with real logic (e.g., call OAuth API)
    console.log(`Refreshing token for ${params.appName}`);
    return { success: true, token: 'new-token' };
  },
  // Add more as needed (sendSms, etc.)
};

module.exports = functions;