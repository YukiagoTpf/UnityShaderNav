Shader "Tests/MultilineCommentOutline" {
  SubShader {
    /*
    Pass {
      Name "FakeCommentedPass"
    }
    */
    Pass {
      Name "RealPass"
      HLSLPROGRAM
      float4 RealEntry() : SV_Target { return 1; }
      ENDHLSL
    }
  }
}
