package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsGoalTemplateCompetencyDTO;
import com.sentrifugo.db.entity.PmsGoalTemplateCompetencyEntity;
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
public interface PmsGoalTemplateCompetencyMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    @Mapping(target = "template", ignore = true)
    @Mapping(target = "competency", ignore = true)
    PmsGoalTemplateCompetencyEntity toEntity(PmsGoalTemplateCompetencyDTO dto);

    @Mapping(source = "template.id", target = "templateId")
    @Mapping(source = "competency.id", target = "competencyId")
    PmsGoalTemplateCompetencyDTO toDTO(PmsGoalTemplateCompetencyEntity entity);

    List<PmsGoalTemplateCompetencyEntity> toEntityList(List<PmsGoalTemplateCompetencyDTO> dtoList);

    List<PmsGoalTemplateCompetencyDTO> toDTOList(List<PmsGoalTemplateCompetencyEntity> entityList);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "template", ignore = true)
    @Mapping(target = "competency", ignore = true)
    void updateEntityFromDto(PmsGoalTemplateCompetencyDTO dto, @MappingTarget PmsGoalTemplateCompetencyEntity entity);
}
