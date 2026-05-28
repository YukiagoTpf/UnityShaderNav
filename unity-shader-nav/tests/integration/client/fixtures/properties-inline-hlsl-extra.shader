Shader "Test/PropertiesInlineHlslExtra" {
  Properties {
    _MainTex ("Base Map", 2D) = "white" {}
    _DoesNotExist ("Missing", Float) = 0
  }
  SubShader {
    Pass {
      HLSLPROGRAM
      TEXTURE2D(_MainTex);
      void frag() {}
      ENDHLSL
    }
  }
}
