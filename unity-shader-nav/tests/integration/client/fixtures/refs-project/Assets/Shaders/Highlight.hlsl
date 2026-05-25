struct Varyings { float4 positionWS; };

float4 frag(Varyings i) {
  InputData inputData;
  inputData.positionWS = i.positionWS;
  inputData.shadowCoord = TransformWorldToShadowCoord(i.positionWS);
  return inputData.positionWS.x;
}
