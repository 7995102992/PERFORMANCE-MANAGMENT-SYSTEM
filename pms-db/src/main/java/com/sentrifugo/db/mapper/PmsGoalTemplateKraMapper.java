package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsGoalTemplateKraDTO;
import com.sentrifugo.db.entity.PmsGoalTemplateKraEntity;
import org.mapstruct.Builder;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingTarget;
import org.mapstruct.NullValuePropertyMappingStrategy;
import org.mapstruct.ReportingPolicy;

import java.util.List;

@Mapper(
        componentModel = "spring",
        unmappedTargetPolicy = ReportingPolicy.IGNORE,
        nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE,
        // Lombok @SuperBuilder entities/DTOs: map through constructor + setters (see PmsCycleMapper).
        builder = @Builder(disableBuilder = true)
)
public interface PmsGoalTemplateKraMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    @Mapping(target = "template", ignore = true)
    @Mapping(target = "kra", ignore = true)
    PmsGoalTemplateKraEntity toEntity(PmsGoalTemplateKraDTO dto);

    @Mapping(source = "template.id", target = "templateId")
    @Mapping(source = "kra.id", target = "kraId")
    PmsGoalTemplateKraDTO toDTO(PmsGoalTemplateKraEntity entity);

    List<PmsGoalTemplateKraEntity> toEntityList(List<PmsGoalTemplateKraDTO> dtoList);

    List<PmsGoalTemplateKraDTO> toDTOList(List<PmsGoalTemplateKraEntity> entityList);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "template", ignore = true)
    @Mapping(target = "kra", ignore = true)
    void updateEntityFromDto(PmsGoalTemplateKraDTO dto, @MappingTarget PmsGoalTemplateKraEntity entity);
}
