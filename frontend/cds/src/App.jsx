import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

const API_BASE = 'http://localhost:5000';
axios.defaults.withCredentials = true;

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);

  const [patients, setPatients] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [patientData, setPatientData] = useState({
    vitals: [],
    labs: [],
    conditions: [],
    medications: [],
    diagnosticReports: []
  });
  const [aiRecommendations, setAiRecommendations] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loadingAI, setLoadingAI] = useState(false);

  useEffect(() => {
    checkAuthStatus();

    const params = new URLSearchParams(window.location.search);
    if (params.get('auth') === 'success') {
      setAuthenticated(true);
      loadPatients();
      window.history.replaceState({}, '', '/');
    } else if (params.get('error')) {
      setError(`Authentication failed: ${params.get('error')}`);
      window.history.replaceState({}, '', '/');
    }
  }, []);

  // const checkAuthStatus = async () => {
  //   try {
  //     const response = await axios.get(`${API_BASE}/api/auth/status`);
  //     setAuthenticated(response.data.authenticated);

  //     if (response.data.authenticated) {
  //       loadPatients();
  //     }
  //   } catch (error) {
  //     console.error('Auth status check failed:', error);
  //   }
  // };
  const checkAuthStatus = async () => {
    try {
      const response = await axios.get(`${API_BASE}/api/auth/status`);
      setAuthenticated(response.data.authenticated);

      if (response.data.authenticated) {
        // Load user profile in parallel
        axios.get(`${API_BASE}/api/user/me`)
          .then(res => setCurrentUser(res.data.user || null))
          .catch(err => console.error('User profile load error:', err));

        loadPatients();
      }
    } catch (error) {
      console.error('Auth status check failed:', error);
    }
  };

  const handleLogin = async () => {
    try {
      const response = await axios.get(`${API_BASE}/launch`);
      window.location.href = response.data.authUrl;
    } catch (error) {
      setError('Failed to initiate login');
      console.error('Login error:', error);
    }
  };

  const loadPatients = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await axios.get(`${API_BASE}/api/patients`);

      if (response.data.entry) {
        setPatients(response.data.entry.map(entry => entry.resource));
      } else {
        setPatients([]);
      }
    } catch (error) {
      setError('Failed to load patients');
      console.error('Patient load error:', error);

      if (error.response?.status === 401) {
        setAuthenticated(false);
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePatientSelect = async (patient) => {
    setSelectedPatient(patient);
    setError(null);
    setAiRecommendations('');

    try {
      // Load all patient data concurrently
      const [vitals, labs, conditions, medications, diagnosticReports] = await Promise.all([
        axios.get(`${API_BASE}/api/patient/${patient.id}/vitals`),
        axios.get(`${API_BASE}/api/patient/${patient.id}/labs`),
        axios.get(`${API_BASE}/api/patient/${patient.id}/conditions`),
        axios.get(`${API_BASE}/api/patient/${patient.id}/medications`),
        axios.get(`${API_BASE}/api/patient/${patient.id}/diagnostic-reports`)
      ]);

      setPatientData({
        vitals: vitals.data.entry || [],
        labs: labs.data.entry || [],
        conditions: conditions.data.entry || [],
        medications: medications.data.entry || [],
        diagnosticReports: diagnosticReports.data.entry || []
      });
    } catch (error) {
      console.error('Error loading patient data:', error);
      setError('Failed to load patient details');
    }
  };
  const isBloodPressurePanel = (obs) =>
    obs.code?.coding?.some(
      c => c.system === 'http://loinc.org' && c.code === '85354-9'
    );

  const isStandaloneBPComponent = (obs) =>
    obs.code?.coding?.some(
      c =>
        c.system === 'http://loinc.org' &&
        (c.code === '8480-6' || c.code === '8462-4')
    );

  const generateAIRecommendations = async () => {
    if (!selectedPatient) return;

    setLoadingAI(true);
    try {
      const response = await axios.post(`${API_BASE}/api/ai/recommendations`, {
        patientId: selectedPatient.id,
        patientData: patientData
      });

      setAiRecommendations(response.data.recommendations);
    } catch (error) {
      console.error('AI recommendations error:', error);
      setError('Failed to generate AI recommendations');
    } finally {
      setLoadingAI(false);
    }
  };

  const handleLogout = async () => {
    try {
      await axios.post(`${API_BASE}/api/logout`);
      setAuthenticated(false);
      setPatients([]);
      setSelectedPatient(null);
      setPatientData({ vitals: [], labs: [], conditions: [], medications: [], diagnosticReports: [] });
      setAiRecommendations('');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const formatName = (patient) => {
    if (!patient.name || patient.name.length === 0) return 'Unknown';
    const name = patient.name[0];
    const given = name.given ? name.given.join(' ') : '';
    const family = name.family || '';
    return `${given} ${family}`.trim() || 'Unknown';
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'Unknown';
    return new Date(dateString).toLocaleDateString();
  };

  const formatObservationValue = (observation) => {
    // Check for dataAbsentReason (no value available)
    if (observation.dataAbsentReason) {
      return observation.dataAbsentReason.coding?.[0]?.display || 'N/A';
    }

    // Handle component-based observations (like Blood Pressure)
    if (observation.component && observation.component.length > 0) {
      return observation.component.map(comp => {
        const name = comp.code?.coding?.[0]?.display?.split(' ')[0] || '';
        const value = comp.valueQuantity?.value || '';
        const unit = comp.valueQuantity?.unit || '';
        return `${name}: ${value}${unit}`;
      }).join(' / ');
    }

    // Handle valueQuantity
    if (observation.valueQuantity) {
      const value = observation.valueQuantity.value;
      const unit = observation.valueQuantity.unit || observation.valueQuantity.code || '';
      // Format the value to 2 decimal places if it's a decimal
      const formattedValue = typeof value === 'number' ?
        (Number.isInteger(value) ? value : value.toFixed(2)) : value;
      return `${formattedValue} ${unit}`;
    }

    // Handle valueCodeableConcept
    if (observation.valueCodeableConcept) {
      return observation.valueCodeableConcept.text ||
        observation.valueCodeableConcept.coding?.[0]?.display || 'N/A';
    }

    // Handle valueString
    if (observation.valueString) {
      return observation.valueString;
    }

    return 'N/A';
  };


  const getObservationName = (observation) => {
    return observation.code?.text || observation.code?.coding?.[0]?.display || 'Unknown';
  };

  if (!authenticated) {
    return (
      <div className="App">
        <div className="login-container">
          <h1>SMART on FHIR Clinical Dashboard</h1>
          <p>Connect to OpenEMR to view patient records and AI recommendations</p>
          {error && <div className="error">{error}</div>}
          <button onClick={handleLogin} className="login-btn">
            Login with SMART on FHIR
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="App">
      {/* <header className="app-header">
        <div className="app-header-left">
          <h1>Clinical Dashboard</h1>
          <span className="app-subtitle">SMART on FHIR · OpenEMR</span>
        </div>
        <div className="header-actions">
          <span className="patient-info">
            {selectedPatient ? `Selected: ${formatName(selectedPatient)}` : 'No patient selected'}
          </span>
          <span className="env-badge">LOCAL</span>
          <button onClick={handleLogout} className="logout-btn">
            Logout
          </button>
        </div>
      </header> */}

      <header className="app-header">
        <div className="app-header-left">
          <h1>Clinical Dashboard</h1>
          <span className="app-subtitle">
            SMART on FHIR · OpenEMR
          </span>
          {currentUser && (
            <span className="app-user">
              Logged in as: <strong>{currentUser.name}</strong> ({currentUser.resourceType}/{currentUser.id})
            </span>
          )}
        </div>

        <div className="header-actions">
          <span className="patient-info">
            {selectedPatient ? `Selected patient: ${formatName(selectedPatient)}` : 'No patient selected'}
          </span>
          <button onClick={handleLogout} className="logout-btn">
            Logout
          </button>
        </div>
      </header>


      <div className="app-main">
        <div className="dashboard-container">
          {/* Left Panel - Patient List */}
          <div className="left-panel">
            <div className="panel-header">
              <h2>Patients ({patients.length})</h2>
            </div>
            <div className="patient-list-panel">
              {loading ? (
                <div className="loading-small">Loading...</div>
              ) : (
                patients.map((patient) => (
                  <div
                    key={patient.id}
                    className={`patient-item ${selectedPatient?.id === patient.id ? 'selected' : ''}`}
                    onClick={() => handlePatientSelect(patient)}
                  >
                    <div className="patient-name">{formatName(patient)}</div>
                    <div className="patient-details">
                      <span>{patient.gender || 'Unknown'}</span>
                      <span>{formatDate(patient.birthDate)}</span>
                    </div>
                    <div className="patient-id">ID: {patient.id}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Middle Panel - Patient Details */}
          <div className="middle-panel">
            {selectedPatient ? (
              <>
                <div className="panel-header">
                  <h2>{formatName(selectedPatient)}</h2>
                  <span className="patient-meta">
                    {selectedPatient.gender} | DOB: {formatDate(selectedPatient.birthDate)}
                  </span>
                </div>

                <div className="patient-details-content">
                  {error && <div className="error">{error}</div>}

                  {/* Vitals Section */}

                  <div className="data-section">
                    <h3>🫀 Vital Signs</h3>
                    <div className="data-grid">
                      {(() => {
                        // Prefer BP panel; if present, drop standalone systolic/diastolic
                        const vitals = patientData.vitals || [];

                        const hasBPPanel = vitals.some(e => isBloodPressurePanel(e.resource));

                        const filtered = vitals.filter(entry => {
                          const obs = entry.resource;

                          // Skip unknown / absent
                          if (obs.dataAbsentReason) return false;

                          // If panel exists, hide standalone systolic/diastolic
                          if (hasBPPanel && isStandaloneBPComponent(obs)) return false;

                          // Skip “panel of panels” (rare in your data, but safe)
                          if (obs.hasMember) return false;

                          return true;
                        });

                        if (filtered.length === 0) {
                          return (
                            <div className="no-data">
                              No vital signs with values available
                            </div>
                          );
                        }

                        return filtered.slice(0, 8).map((entry, idx) => {
                          const obs = entry.resource;
                          return (
                            <div key={obs.id || idx} className="data-card">
                              <div className="data-label">{getObservationName(obs)}</div>
                              <div className="data-value">{formatObservationValue(obs)}</div>
                              <div className="data-date">
                                {formatDate(obs.effectiveDateTime)}
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>



                  {/* Lab Results Section */}
                  <div className="data-section">
                    <h3>🧪 Lab Results</h3>
                    <div className="data-list">
                      {patientData.labs.length > 0 ? (
                        patientData.labs.slice(0, 5).map((entry, idx) => {
                          const obs = entry.resource;
                          return (
                            <div key={idx} className="data-row">
                              <span className="row-label">{getObservationName(obs)}</span>
                              <span className="row-value">{formatObservationValue(obs)}</span>
                              <span className="row-date">{formatDate(obs.effectiveDateTime)}</span>
                            </div>
                          );
                        })
                      ) : (
                        <div className="no-data">No lab results available</div>
                      )}
                    </div>
                  </div>

                  {/* Conditions Section */}
                  <div className="data-section">
                    <h3>🩺 Conditions</h3>
                    <div className="data-list">
                      {patientData.conditions.length > 0 ? (
                        patientData.conditions.map((entry, idx) => {
                          const condition = entry.resource;
                          return (
                            <div key={idx} className="data-row">
                              <span className="row-label">
                                {condition.code?.text || condition.code?.coding?.[0]?.display || 'Unknown condition'}
                              </span>
                              <span className={`status-badge ${condition.clinicalStatus?.coding?.[0]?.code || 'unknown'}`}>
                                {condition.clinicalStatus?.coding?.[0]?.code || 'Unknown'}
                              </span>
                              <span className="row-date">{formatDate(condition.recordedDate)}</span>
                            </div>
                          );
                        })
                      ) : (
                        <div className="no-data">No conditions recorded</div>
                      )}
                    </div>
                  </div>

                  {/* Medications Section */}
                  <div className="data-section">
                    <h3>💊 Medications</h3>
                    <div className="data-list">
                      {patientData.medications.length > 0 ? (
                        patientData.medications.map((entry, idx) => {
                          const med = entry.resource;
                          return (
                            <div key={idx} className="data-row">
                              <span className="row-label">
                                {med.medicationCodeableConcept?.text ||
                                  med.medicationCodeableConcept?.coding?.[0]?.display ||
                                  'Unknown medication'}
                              </span>
                              <span className="row-value">
                                {med.dosageInstruction?.[0]?.text || 'No dosage info'}
                              </span>
                              <span className={`status-badge ${med.status || 'unknown'}`}>
                                {med.status || 'Unknown'}
                              </span>
                            </div>
                          );
                        })
                      ) : (
                        <div className="no-data">No medications recorded</div>
                      )}
                    </div>
                  </div>

                  {/* Diagnostic Reports Section */}
                  <div className="data-section">
                    <h3>📊 Diagnostic Reports</h3>
                    <div className="data-list">
                      {patientData.diagnosticReports.length > 0 ? (
                        patientData.diagnosticReports.map((entry, idx) => {
                          const report = entry.resource;
                          return (
                            <div key={idx} className="data-row">
                              <span className="row-label">
                                {report.code?.text || report.code?.coding?.[0]?.display || 'Unknown report'}
                              </span>
                              <span className={`status-badge ${report.status || 'unknown'}`}>
                                {report.status || 'Unknown'}
                              </span>
                              <span className="row-date">{formatDate(report.effectiveDateTime)}</span>
                            </div>
                          );
                        })
                      ) : (
                        <div className="no-data">No diagnostic reports available</div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="no-selection">
                <div className="no-selection-icon">👈</div>
                <h3>Select a patient</h3>
                <p>Choose a patient from the list to view their clinical data</p>
              </div>
            )}
          </div>

          {/* Right Panel - AI Recommendations */}
          <div className="right-panel">
            <div className="panel-header">
              <h2>🤖 AI Agent</h2>
            </div>
            <div className="ai-panel-content">
              {selectedPatient ? (
                <>
                  <button
                    onClick={generateAIRecommendations}
                    className="ai-generate-btn"
                    disabled={loadingAI}
                  >
                    {loadingAI ? 'Analyzing...' : 'Generate Recommendations'}
                  </button>

                  {aiRecommendations ? (
                    <div className="ai-recommendations">
                      <div className="ai-content">
                        {aiRecommendations.split('\n').map((line, idx) => (
                          <p key={idx}>{line}</p>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="ai-placeholder">
                      <div className="ai-icon">🧠</div>
                      <p>Click "Generate Recommendations" to get AI-powered clinical insights based on the patient's data</p>
                    </div>
                  )}
                </>
              ) : (
                <div className="ai-placeholder">
                  <div className="ai-icon">🤖</div>
                  <p>Select a patient to enable AI recommendations</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
